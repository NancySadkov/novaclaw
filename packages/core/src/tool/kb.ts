export * as KbTool from "./kb"

import { readFileSync, statSync } from "node:fs"
import { basename } from "node:path"
import { ascending } from "@novaclaw/schema/identifier"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { KbChunk } from "../kb-graph/chunk"
import { KbEmbedder } from "../kb-graph/embedder"
import * as MemoryAccess from "../kb-graph/memory-access"
import { MemoryClient } from "../kb-graph/memory-client"
import { MemoryRanking } from "../kb-graph/ranking"
import { Memory } from "../kb-graph/memory"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { stanceOf } from "../session/config-resolve"
import { SessionEffectiveConfig } from "../session/effective-config"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// The `kb` tool — the model-facing surface of the graph MEMORY tier (notes/kb-graph-plan.md §3; the
// KB is now the Ladybug in-process graph, not the KB-V doc store). ONE tool, a closed op vocab the
// model CHAINS: `search` (find memories) → `neighbors` (what's linked) plus the deliberate writes
// `remember` / `forget`. The measured KB-E/KB-V rules carry over: results are LINEARIZED text lines,
// never nested JSON; a fruitless query settles as readable repair text (the model's next call IS the
// repair loop); ToolFailure stays reserved for infra faults. Memory disabled/unavailable → the ops
// degrade to repair text, never a hard failure.
//
// THREE SCOPES, since the roster landed (AGENTS.md — the structural metaphor): `session:<id>` (this
// chat), `agent:<id>` (this OFFICER's own cabinet, across its chats, invisible to every other agent)
// and `global` (the household's shared facts, readable by all). A write defaults to the officer's
// cabinet — a fact learned on the job belongs to the officer, not to the pile everyone reads.

export const name = "kb"

const SearchOp = Schema.Struct({
  op: Schema.Literal("search"),
  query: Schema.String.annotate({ description: "Free-text query; matches remembered facts by keyword" }),
  k: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max results (default 8)" }),
  scope: Schema.Literals(["session", "agent", "global", "all"])
    .pipe(Schema.optional)
    .annotate({
      description:
        "session = this chat only · agent = your own memory, across your chats · global = shared facts every agent knows · all (default)",
    }),
})

const RememberOp = Schema.Struct({
  op: Schema.Literal("remember"),
  text: Schema.String.annotate({ description: "The fact to remember, as one clear standalone sentence" }),
  name: Schema.String.pipe(Schema.optional).annotate({
    description: "Short subject/label (e.g. the person or thing it's about)",
  }),
  scope: Schema.Literals(["session", "agent", "global"])
    .pipe(Schema.optional)
    .annotate({
      description:
        "agent (default) = your own durable memory · global = a fact about the user or household that every agent should know · session = only this chat",
    }),
})

const ForgetOp = Schema.Struct({
  op: Schema.Literal("forget"),
  id: Schema.String.annotate({ description: "A memory id from search results (mem_…)" }),
  secret: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "true = hard-delete with no history (for secrets/credentials); default keeps it in history",
  }),
})

const NeighborsOp = Schema.Struct({
  op: Schema.Literal("neighbors"),
  id: Schema.String.annotate({ description: "A memory id (mem_…) whose directly-linked memories to list" }),
  k: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max results (default 10)" }),
})

const RelateOp = Schema.Struct({
  op: Schema.Literal("relate"),
  from: Schema.String.annotate({ description: "The subject memory id (mem_… from a remember/search result)" }),
  to: Schema.String.annotate({ description: "The object memory id (mem_… from a remember/search result)" }),
  type: Schema.String.annotate({
    description: "The relationship as a short verb phrase, e.g. works_at, wrote, located_in, part_of, depends_on",
  }),
})

const IngestOp = Schema.Struct({
  op: Schema.Literal("ingest"),
  path: Schema.String.annotate({
    description:
      "Path to a text document to read into memory as searchable passages. The document does NOT enter your context — ingest a big file, then `search` it.",
  }),
  name: Schema.String.pipe(Schema.optional).annotate({
    description: "Short label for the source (defaults to the file name)",
  }),
  scope: Schema.Literals(["session", "agent", "global"])
    .pipe(Schema.optional)
    .annotate({
      description:
        "agent (default) = readable in your own chats · global = readable by every agent · session = only this chat",
    }),
})

export const Input = Schema.Union([SearchOp, RememberOp, ForgetOp, NeighborsOp, RelateOp, IngestOp])

/** Refuse pathological inputs rather than melting the index on a 500MB blob. */
export const MAX_INGEST_BYTES = 4_000_000
/** Re-exported so the tool surface stays stable; the rule lives with chunking (kb-graph/chunk.ts). */
export const passageID = KbChunk.passageID

const Output = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
})
type Output = typeof Output.Type

// --- linearized rendering (pure; unit-tested) --------------------------------------------------

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim()

// Normalize a relationship label to a clean predicate token ("works at" → "works_at") so links read
// consistently and traverse predictably. Empty/garbage → a neutral default.
export const relType = (type: string): string => oneLine(type).toLowerCase().replaceAll(/\s+/g, "_") || "related_to"

export const formatHits = (hits: ReadonlyArray<MemoryClient.SearchHit>): string =>
  hits
    .map((hit) => {
      const provenance = [hit.relation, hit.source].filter(Boolean).join("/")
      const label = hit.name ? `${hit.name}: ` : ""
      return `${hit.id} · ${label}${oneLine(hit.text)}${provenance ? ` · ${provenance}` : ""}`
    })
    .join("\n")

export const formatNeighbors = (rows: ReadonlyArray<MemoryClient.Neighbor>): string =>
  rows.map((row) => `${row.id} · [${row.type}] ${oneLine(row.text)}`).join("\n")

export const searchRepair = (query: string): string =>
  `No memories match "${query}". Try different or fewer words, or {"op":"remember","text":"…"} to save it.`

// -----------------------------------------------------------------------------------------------

// Ordering can only choose among retrieved candidates, so fetch a wider pool than we return.
const OVERFETCH = 3
const OVERFETCH_CAP = 40

/** The agent's own filing cabinet, or `undefined` when this session has no agent to own one.
 *
 *  🔴 **Why the surface grew a third literal instead of re-pointing `session`** (the decision
 *  `notes/named-agents.md` reserved). Under the roster (AGENTS.md — the structural metaphor) there are
 *  genuinely three durable places a fact can belong: this chat, this OFFICER across its chats, and the
 *  household every agent shares. Re-pointing `session` at the agent would have kept the vocabulary
 *  two-wide by making its own description ("this chat only") false, and a lying enum is worse than a
 *  wider one — the model reads these strings and the user reads the same words in the UI. */
export const agentScope = (agent: string | undefined): string | undefined =>
  agent === undefined || agent === "" ? undefined : `agent:${agent}`

/** Which scopes a `search` reads. `all` is everything this agent may see — never another agent's
 *  cabinet, which is not reachable through any value of this parameter. */
export const scopesForSearch = (
  session: string,
  agent: string | undefined,
  scope: "session" | "agent" | "global" | "all" | undefined,
): string[] => {
  const own = agentScope(agent)
  if (scope === "session") return [session]
  if (scope === "global") return ["global"]
  // A request for `agent` on a session that has none degrades to this chat rather than to `global`:
  // widening a narrowing request is the one direction that can leak.
  if (scope === "agent") return own === undefined ? [session] : [own]
  return own === undefined ? [session, "global"] : [session, own, "global"]
}

/** Where a `remember`/`ingest` writes. The default is the OFFICER's cabinet — an officer's durable
 *  fact belongs to the officer, not to whichever chat was open and not to the household pile every
 *  other agent reads. With no agent, `global` remains the durable default, as before. */
export const scopeForWrite = (
  session: string,
  agent: string | undefined,
  scope: "session" | "agent" | "global" | undefined,
): string => {
  if (scope === "session") return session
  if (scope === "global") return "global"
  return agentScope(agent) ?? "global"
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const memory = Memory.client(yield* Memory.node.service)
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const effective = yield* SessionEffectiveConfig.Service

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            description:
              "The agent's long-term memory — a knowledge GRAPH. Ops: search (find things you've remembered, " +
              "by keyword) · remember (save a fact; returns its id — default durably across all chats) · relate " +
              "(link two remembered ids with a relationship like works_at, so you can later trace multi-step " +
              "connections neighbors/search alone can't) · forget (drop a memory by id) · neighbors (memories " +
              "linked to one you found) · ingest (read a text DOCUMENT at a path into memory as searchable " +
              "passages — the file never enters your context, so ingest a big manual then search it). " +
              "Chain them: remember the entities, then relate what connects them. " +
              'Example: {"op":"remember","text":"Ada Lovelace","name":"Ada"} → {"op":"relate","from":"mem_…","to":"mem_…","type":"wrote"}.',
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              Effect.gen(function* () {
                // The user's Memory switch (Settings → Memory) is OFF → the tool stands down entirely:
                // no recall AND no writing, so "memory off" is honest for the agent too.
                // Through the ONE entry point: `memory` is a folder-settable switch, and its other
                // reader (`runner/maintenance.ts`'s auto-extraction) resolves the same way. A tool
                // that stood down while extraction kept writing would be "memory off" for half the
                // system.
                const sessionConfig = yield* effective.resolve(context.sessionID)
                // The resolved value already carries the instance ceiling.
                if (!stanceOf("memory", sessionConfig.memory))
                  return {
                    ok: false,
                    message:
                      "Long-term memory is turned off for this chat or in Settings, so I can't recall or save memories right now.",
                  } satisfies Output
                const sessionScope = `session:${context.sessionID}`
                // The officer whose cabinet this turn writes to and reads from. A sub-agent carries its
                // parent's agent through the config walk, so staff share their officer's cabinet and
                // cannot reach a sibling's.
                const agentID = sessionConfig.agent
                /**
                 * 🔴 WHAT THIS TURN MAY TOUCH — built once, passed to every id-based operation.
                 *
                 * NC-SEC-016: `search` derived a scope set and the other operations did not, so
                 * `neighbors`/`forget` reached anything by id. Measured on the shipping engine — one
                 * chat read another chat's private text through a global neighbour and hard-deleted
                 * it. Deriving the set ONCE and handing it down is the shape that cannot drift: a new
                 * `op` added below cannot compile without saying what it may reach.
                 *
                 * `all` is exactly what `search` already meant by it — this chat, this officer's
                 * cabinet, and the household's shared facts. Never another officer's.
                 */
                const access = MemoryAccess.of(scopesForSearch(sessionScope, agentID, "all"))
                switch (input.op) {
                  case "search": {
                    // The VECTOR leg: embedding the query makes the engine fuse vector KNN with FTS
                    // (measured 85% vs 77% keyword-only). Undefined = no device ⇒ keyword-only, never a failure.
                    const queryVector = yield* Effect.promise(() => KbEmbedder.embedOne(input.query))
                    const k = input.k ?? 8
                    const candidates = yield* memory
                      .search({
                        query: input.query,
                        // Over-fetch, then re-rank down to k: ordering can only choose among what
                        // retrieval returned, so the candidate pool must be wider than the answer.
                        k: Math.min(k * OVERFETCH, OVERFETCH_CAP),
                        scopes: scopesForSearch(sessionScope, agentID, input.scope),
                        ...(queryVector === undefined ? {} : { embedding: queryVector }),
                      })
                      .pipe(Effect.orElseSucceed(() => []))
                    if (candidates.length === 0)
                      return { ok: false, message: searchRepair(input.query) } satisfies Output
                    // P8: recency × authority re-rank (bounded — see ranking.ts). A no-op when the hits
                    // share provenance and age.
                    const hits = MemoryRanking.rankHits(candidates, Date.now()).slice(0, k)
                    return { ok: true, message: formatHits(hits) } satisfies Output
                  }
                  case "remember": {
                    const id = "mem_" + ascending()
                    const scope = scopeForWrite(sessionScope, agentID, input.scope)
                    // Embed on write so this memory is reachable by the vector leg later; degrades to
                    // an FTS-only memory when no device is configured.
                    const vector = yield* Effect.promise(() => KbEmbedder.embedOne(input.text))
                    return yield* memory
                      .addMemory({
                        id,
                        kind: "entity",
                        text: input.text,
                        ...(input.name === undefined ? {} : { name: input.name }),
                        scope,
                        relation: "staged",
                        ...(vector === undefined ? {} : { embedding: vector }),
                      })
                      .pipe(
                        Effect.as({
                          ok: true,
                          message: `Remembered (${id})${input.scope === "session" ? " — this chat only" : ""}.`,
                        } satisfies Output),
                        Effect.catch((error) =>
                          Effect.succeed({
                            ok: false,
                            message: `Couldn't save that memory right now (${error.reason}).`,
                          } satisfies Output),
                        ),
                      )
                  }
                  case "forget": {
                    return yield* (
                      input.secret ? memory.purge(input.id, access) : memory.invalidate(input.id, access)
                    ).pipe(
                      Effect.as({
                        ok: true,
                        message: input.secret
                          ? `Purged "${input.id}" — no history kept.`
                          : `Forgot "${input.id}" (kept in history; it won't surface in search).`,
                      } satisfies Output),
                      Effect.catch((error) =>
                        Effect.succeed({
                          ok: false,
                          message: `Couldn't forget "${input.id}" (${error.reason}).`,
                        } satisfies Output),
                      ),
                    )
                  }
                  case "neighbors": {
                    const rows = yield* memory
                      .neighbors(input.id, access, { k: input.k ?? 10 })
                      .pipe(Effect.orElseSucceed(() => []))
                    if (rows.length === 0)
                      return {
                        ok: false,
                        message: `No memories linked to "${input.id}" yet. Create links with {"op":"relate","from":"…","to":"…","type":"…"}; ids come from remember/search results (mem_…).`,
                      } satisfies Output
                    return { ok: true, message: formatNeighbors(rows) } satisfies Output
                  }
                  case "ingest": {
                    // Path/permission faults settle as readable text like every other op here —
                    // ToolFailure stays reserved for infra, so a denied read is guidance, not a crash.
                    return yield* Effect.gen(function* () {
                      // Read a document into memory as passages. The point is that the document NEVER
                      // enters the model's context — ingest a 200KB manual, then `search` it.
                      const source = {
                        type: "tool" as const,
                        messageID: context.assistantMessageID,
                        callID: context.toolCallID,
                      }
                      const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                      if (target.externalDirectory)
                        yield* permission.assert({
                          ...LocationMutation.externalDirectoryPermission(target.externalDirectory, "read"),
                          sessionID: context.sessionID,
                          agent: context.agent,
                          source,
                        })
                      yield* permission.assert({
                        action: name,
                        resources: [target.resource],
                        save: ["*"],
                        sessionID: context.sessionID,
                        agent: context.agent,
                        source,
                      })
                      let stat: ReturnType<typeof statSync> | undefined
                      try {
                        stat = statSync(target.canonical)
                      } catch {
                        stat = undefined
                      }
                      if (stat === undefined || !stat.isFile())
                        return { ok: false, message: `No readable file at "${input.path}".` } satisfies Output
                      if (stat.size > MAX_INGEST_BYTES)
                        return {
                          ok: false,
                          message: `That document is ~${Math.round(stat.size / 1e6)}MB — over the ${MAX_INGEST_BYTES / 1e6}MB ingest limit. Split it and ingest the parts.`,
                        } satisfies Output
                      let raw: string | undefined
                      try {
                        raw = readFileSync(target.canonical, "utf8")
                      } catch {
                        raw = undefined
                      }
                      if (raw === undefined)
                        return { ok: false, message: `Couldn't read "${input.path}".` } satisfies Output
                      if (raw.includes("\x00"))
                        return {
                          ok: false,
                          message: `"${input.path}" looks like a binary file — ingest text documents only.`,
                        } satisfies Output
                      const label = input.name?.trim() || basename(target.canonical)
                      const ingestScope = scopeForWrite(sessionScope, agentID, input.scope)
                      const passages = KbChunk.chunk(KbChunk.stripGutenberg(raw))
                      if (passages.length === 0)
                        return { ok: false, message: `"${label}" has no readable text to ingest.` } satisfies Output
                      // A duplicate id does NOT fail on the real engine (measured) — it dedupes by primary
                      // key and addMemory still succeeds. Counting successful calls would claim we stored
                      // passages we did not, so count the actual delta.
                      const before = yield* memory.stats().pipe(Effect.orElseSucceed(() => ({ total: 0, valid: 0 })))
                      for (const text of passages) {
                        yield* memory
                          .addMemory({
                            id: passageID(label, text),
                            kind: "passage",
                            text,
                            name: label,
                            scope: ingestScope,
                            source: "ingest",
                            relation: "staged",
                          })
                          .pipe(Effect.ignore)
                      }
                      const after = yield* memory.stats().pipe(Effect.orElseSucceed(() => ({ total: 0, valid: 0 })))
                      const stored = Math.max(0, after.total - before.total)
                      // Content-addressed ids make re-ingest idempotent: nothing new is not a failure.
                      if (stored === 0)
                        return {
                          ok: true,
                          message: `"${label}" is already in memory (${passages.length} passages, nothing new).`,
                        } satisfies Output
                      return {
                        ok: true,
                        message:
                          `Ingested "${label}" as ${stored} searchable passage${stored === 1 ? "" : "s"}` +
                          `${ingestScope === "global" ? "" : " (this chat only)"}. Find things in it with {"op":"search","query":"…"}.`,
                      } satisfies Output
                    }).pipe(
                      Effect.catch((error) => {
                        // 🔴 A refusal the USER authored — a `novaclaw.json` exclusion, or a
                        // permission denial — already has its own finished sentence, and it is taken
                        // FIRST. `denialMessage` is the absorber every other path-taking tool routes
                        // through (`project-exclusion.test.ts` holds that ledger); `kb` was the one
                        // exception, and the cost was measurable rather than theoretical: it emitted
                        // `Couldn't ingest "vault/prod.env" — ProjectExclusion.ExcludedError: Refused
                        // by a project exclusion: …`, i.e. an internal tag wedged in front of the
                        // user's own words. A refusal that reads differently in one tool teaches the
                        // model that this tool is where the rules are different, which is exactly the
                        // retry-forever behaviour the legible refusal exists to stop.
                        const denial = PermissionV2.denialMessage(error)
                        if (denial) return Effect.succeed({ ok: false, message: denial } satisfies Output)
                        // Everything else: name the failure class — "PathError: outside the location"
                        // is actionable; a bare empty message is not.
                        const e = error as { _tag?: string; message?: string; reason?: string }
                        const detail = [e._tag, e.message || e.reason].filter(Boolean).join(": ") || String(error)
                        return Effect.succeed({
                          ok: false,
                          message: `Couldn't ingest "${input.path}" — ${detail}`,
                        } satisfies Output)
                      }),
                    )
                  }
                  case "relate": {
                    const type = relType(input.type)
                    return yield* memory.addEdge({ from: input.from, to: input.to, type, scope: "global" }).pipe(
                      Effect.as({
                        ok: true,
                        message: `Linked ${input.from} —[${type}]→ ${input.to}.`,
                      } satisfies Output),
                      Effect.catch((error) =>
                        Effect.succeed({
                          ok: false,
                          message: `Couldn't link those (${error.reason}). Both ids come from remember/search results (mem_…).`,
                        } satisfies Output),
                      ),
                    )
                  }
                }
              }),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/kb",
  layer,
  deps: [ToolRegistry.node, Memory.node, LocationMutation.node, PermissionV2.node, SessionEffectiveConfig.node],
})
