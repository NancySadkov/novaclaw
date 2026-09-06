export * as KbTool from "./kb"

import { readFileSync, statSync } from "node:fs"
import { basename } from "node:path"
import { ascending } from "@novaclaw/schema/identifier"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { KbChunk } from "../kb-graph/chunk"
import { KbClaim } from "../kb-graph/claim"
import { KbEmbedder } from "../kb-graph/embedder"
import * as MemoryAccess from "../kb-graph/memory-access"
import { MemoryClient } from "../kb-graph/memory-client"
import { MemoryRanking } from "../kb-graph/ranking"
import { Memory } from "../kb-graph/memory"
import * as MemoryReference from "../kb-graph/reference"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { stanceOf } from "../session/config-resolve"
import { SessionEffectiveConfig } from "../session/effective-config"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// The `kb` tool — the model-facing surface of the graph MEMORY tier (the
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
  scope: Schema.Literals(["session", "agent", "global", "all"]).pipe(Schema.optional).annotate({
    description:
      "session = this chat only · agent = your own memory, across your chats · global = shared facts every agent knows · all (default)",
  }),
})

const ResolveOp = Schema.Struct({
  op: Schema.Literal("resolve"),
  label: Schema.String.annotate({ description: "A remembered subject or label to resolve to one or more references" }),
  k: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max candidates (default 8)" }),
})

const GetOp = Schema.Struct({
  op: Schema.Literal("get"),
  id: Schema.String.annotate({ description: "A reference returned by search, resolve or remember" }),
})

const PredicatesOp = Schema.Struct({
  op: Schema.Literal("predicates"),
  id: Schema.String.pipe(Schema.optional).annotate({ description: "A reference whose relationship types to inspect" }),
  k: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max linked memories to inspect (default 64)" }),
})

const RememberOp = Schema.Struct({
  op: Schema.Literal("remember"),
  text: Schema.String.annotate({ description: "The fact to remember, as one clear standalone sentence" }),
  name: Schema.String.pipe(Schema.optional).annotate({
    description: "Short subject/label (e.g. the person or thing it's about)",
  }),
  /**
   * 🔴 A CLOSED PICK, never free text — the measured rule from the query-surface eval: a model picks
   * from a list reliably and generates a vocabulary badly, and with guided decoding an invalid value
   * becomes unsamplable. That matters more here than anywhere else in this tool, because this field
   * is what authorises one memory to RETIRE another. An open field would be an invitation to invent a
   * predicate, and every invented predicate is a correction that silently does not happen.
   */
  predicate: Schema.Literals(KbClaim.CLAIM_PREDICATE_NAMES)
    .pipe(Schema.optional)
    .annotate({
      description:
        "Which question about `name` this answers. Use it when the fact REPLACES an older answer: " +
        "employer, role, location, email, phone, timezone, language, birthday, preference, status, " +
        "version, path, owner and name each have ONE current answer, so saving a new one retires the " +
        "old one (kept in history). about/likes/dislikes/knows/uses/works_on accumulate instead. " +
        "Default: about.",
    }),
  scope: Schema.Literals(["session", "agent", "global"]).pipe(Schema.optional).annotate({
    description:
      "agent (default) = your own durable memory · global = a fact about the user or household that every agent should know · session = only this chat",
  }),
})

const HistoryOp = Schema.Struct({
  op: Schema.Literal("history"),
  id: Schema.String.annotate({
    description: "A reference returned by search or remember whose history to show — what it replaced, and why",
  }),
})

const ForgetOp = Schema.Struct({
  op: Schema.Literal("forget"),
  id: Schema.String.annotate({ description: "A reference returned by search or remember" }),
  secret: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "true = hard-delete with no history (for secrets/credentials); default keeps it in history",
  }),
})

const NeighborsOp = Schema.Struct({
  op: Schema.Literal("neighbors"),
  id: Schema.String.annotate({ description: "A reference returned by search or remember whose links to list" }),
  k: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max results (default 10)" }),
})

const RelateOp = Schema.Struct({
  op: Schema.Literal("relate"),
  from: Schema.String.annotate({ description: "The subject reference returned by remember or search" }),
  to: Schema.String.annotate({ description: "The object reference returned by remember or search" }),
  type: Schema.Literals(KbClaim.RELATION_TYPE_NAMES).annotate({
    description: "The relationship, chosen from the engine's closed vocabulary",
  }),
})

const PathOp = Schema.Struct({
  op: Schema.Literal("path"),
  from: Schema.String.annotate({ description: "The starting reference returned by search or remember" }),
  to: Schema.String.annotate({ description: "The destination reference returned by search or remember" }),
  maxHops: Schema.Finite.pipe(Schema.optional).annotate({ description: "Maximum graph hops (default 5, max 8)" }),
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
  scope: Schema.Literals(["session", "agent", "global"]).pipe(Schema.optional).annotate({
    description:
      "agent (default) = readable in your own chats · global = readable by every agent · session = only this chat",
  }),
})

export const Input = Schema.Union([
  SearchOp,
  ResolveOp,
  GetOp,
  PredicatesOp,
  RememberOp,
  ForgetOp,
  NeighborsOp,
  RelateOp,
  PathOp,
  IngestOp,
  HistoryOp,
])

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

// Normalize a relationship label for internal callers and rendering tests. The model-facing schema
// uses KbClaim.RELATION_TYPE_NAMES, so arbitrary model-authored predicates never reach the engine.
export const relType = (type: string): string => oneLine(type).toLowerCase().replaceAll(/\s+/g, "_") || "related_to"

export type ReferenceRenderer = (storageID: string) => string

export const formatHits = (
  hits: ReadonlyArray<MemoryClient.SearchHit>,
  renderID: ReferenceRenderer = (storageID) => storageID,
): string =>
  hits
    .map((hit) => {
      const provenance = [hit.relation, hit.source].filter(Boolean).join("/")
      const label = hit.name ? `${hit.name}: ` : ""
      // ⚠️ The flag rides the LINE, not a separate field. A claim whose citation moved is still the
      // best answer available, and the model can only caveat it if it can see the caveat — a status
      // the retrieval layer knows and the rendering drops is a status nobody acts on.
      const flag = hit.status === "needs_review" ? " · NEEDS CHECKING (its source moved)" : ""
      return `${renderID(hit.id)} · ${label}${oneLine(hit.text)}${provenance ? ` · ${provenance}` : ""}${flag}`
    })
    .join("\n")

/** Render a claim's timeline: what it says now, what it replaced, and what each rested on. This IS
 *  the "explains the old assertion" half of the lifecycle — a correction nobody can read the reason
 *  for is indistinguishable from a memory that went missing. */
export const formatHistory = (
  history: MemoryClient.ClaimHistory,
  renderID: ReferenceRenderer = (storageID) => storageID,
): string => {
  const cite = (claimID: string) => {
    const rows = history.evidence.filter((row) => row.claimID === claimID)
    return rows.length === 0 ? "" : ` — ${rows.map((row) => oneLine(row.label)).join("; ")}`
  }
  const lines = history.timeline.map((entry, index) => {
    const mark = index === 0 ? "" : "replaced: "
    const state = entry.status === "active" ? "current" : entry.status.replaceAll("_", " ")
    return `${renderID(entry.id)} · ${mark}${oneLine(entry.text)} · ${state}${cite(entry.id)}`
  })
  if (history.current !== null)
    lines.push(`The current answer is now ${renderID(history.current.id)}: ${oneLine(history.current.text)}`)
  return lines.join("\n")
}

export const formatNeighbors = (
  rows: ReadonlyArray<MemoryClient.Neighbor>,
  renderID: ReferenceRenderer = (storageID) => storageID,
): string => rows.map((row) => `${renderID(row.id)} · [${row.type}] ${oneLine(row.text)}`).join("\n")

export const formatPath = (
  path: MemoryClient.PathResult,
  renderID: ReferenceRenderer = (storageID) => storageID,
): string => (path === null ? "" : `Path (${path.hops} hops): ${path.ids.map(renderID).join(" → ")}`)

export const searchRepair = (query: string): string =>
  `No memories match "${query}". Try different or fewer words, or {"op":"remember","text":"…"} to save it.`

/**
 * 🔴 RULING 2 — *an unavailable subsystem names itself instead of rendering empty*, and *a failed
 * mutation never reports success*.
 *
 * Every read op here used to fold its error channel into the SAME value an honest miss produces
 * (`orElseSucceed(() => [])`, `=> null`, `=> {total: 0}`), and `ingest` discarded every write error
 * outright. So "the graph has nothing for you" and "the engine is not answering" reached the model
 * as one sentence — and the repair for the first (rephrase it, or remember it) is exactly the wrong
 * move for the second, which is why the two must not share a line. `remember`/`forget`/`relate`
 * already got this right in this same file; these are the sites that did not.
 *
 * The engine's own reason rides the line, and so does the ONE action that repairs it: `memory` is a
 * lazy capability (`kb-graph/memory.ts:377`), so a cached acquisition failure is cleared by
 * `configure`'s `retry` op and by nothing else the model can reach.
 */
export const engineDown = (what: string, reason: string): string =>
  `Couldn't ${what.replaceAll(/\b(?:mem|clm)_[A-Za-z0-9_]+\b/g, "<storage-id>")} — long-term memory isn't answering (${reason.replaceAll(/\b(?:mem|clm)_[A-Za-z0-9_]+\b/g, "<storage-id>")}). This is NOT "nothing found": ` +
  `nothing was read or written. Retry the capability with the configure tool — ` +
  `{"op":"retry","capability":"memory"} — then try this again.`

// -----------------------------------------------------------------------------------------------

/** A memory op's outcome with the engine fault kept SEPARATE from the value, so no caller below can
 *  reconstruct the collapse this file was fixed for: `fault !== undefined` is the only thing that
 *  means "the engine did not answer", and it is never `[]`, `null` or `0`. */
type Probe<A> = { readonly value: A | undefined; readonly fault: string | undefined }

const probe = <A>(effect: Effect.Effect<A, MemoryClient.MemoryError>): Effect.Effect<Probe<A>> =>
  effect.pipe(
    Effect.map((value): Probe<A> => ({ value, fault: undefined })),
    Effect.catch((error): Effect.Effect<Probe<A>> => Effect.succeed({ value: undefined, fault: error.reason })),
  )

// Ordering can only choose among retrieved candidates, so fetch a wider pool than we return.
const OVERFETCH = 3
const OVERFETCH_CAP = 40

export const metadata = {
  description:
    "The agent's long-term memory — a knowledge GRAPH. Ops: search (find things you've remembered, " +
    "by keyword) · resolve (turn a subject label into bounded references) · get (read one " +
    "reference) · predicates (inspect the closed relationship vocabulary) · " +
    "remember (save a fact; returns a reference — default durably across all chats; give " +
    "`name` + `predicate` and a NEW answer retires the old one instead of piling up beside it) · " +
    "history (what a memory replaced, and what it rested on) · relate " +
    "(link two remembered references with a closed relationship type, so you can later trace multi-step " +
    "connections neighbors/search alone can't) · forget (drop a memory by reference) · neighbors (memories " +
    "linked to one you found) · path (let the engine answer a bounded multi-hop question) · ingest (read a text DOCUMENT at a path into memory as searchable " +
    "passages — the file never enters your context, so ingest a big manual then search it). " +
    "Chain them: remember the entities, then relate what connects them. " +
    'Example: {"op":"remember","text":"Ada Lovelace","name":"Ada"} → {"op":"relate","from":"ref_…","to":"ref_…","type":"wrote"}.',
  input: Input,
  output: Output,
} as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const memory = Memory.client(yield* Memory.node.service)
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const effective = yield* SessionEffectiveConfig.Service
    const references = MemoryReference.make()

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
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
                const access = MemoryAccess.of(MemoryAccess.scopesForSearch(sessionScope, agentID, "all"))
                const renderID = (storageID: string) => references.issue(context.sessionID, storageID)
                const resolveID = (reference: string) => references.resolve(context.sessionID, reference)
                const displayReference = (reference: string) =>
                  MemoryReference.isHandle(reference) ? reference : "<invalid-reference>"
                const unknownReference = (reference: string) =>
                  `That memory reference is unknown or expired ("${displayReference(reference)}"). Search or remember it again, then use the new reference.`
                switch (input.op) {
                  case "search": {
                    // The VECTOR leg: embedding the query makes the engine fuse vector KNN with FTS
                    // (measured 85% vs 77% keyword-only). Undefined = no device ⇒ keyword-only, never a failure.
                    const queryVector = yield* Effect.promise(() => KbEmbedder.embedOne(input.query))
                    const k = input.k ?? 8
                    const found = yield* probe(
                      memory.search({
                        query: input.query,
                        // Over-fetch, then re-rank down to k: ordering can only choose among what
                        // retrieval returned, so the candidate pool must be wider than the answer.
                        k: Math.min(k * OVERFETCH, OVERFETCH_CAP),
                        scopes: MemoryAccess.scopesForSearch(sessionScope, agentID, input.scope),
                        surface: "kb-tool",
                        ...(queryVector === undefined ? {} : { embedding: queryVector }),
                      }),
                    )
                    // A down engine is not a fruitless query: `searchRepair` tells the model to
                    // rephrase, which it would then do forever against a store it never reached.
                    if (found.fault !== undefined)
                      return {
                        ok: false,
                        message: engineDown(`search memory for "${input.query}"`, found.fault),
                      } satisfies Output
                    const candidates = found.value ?? []
                    if (candidates.length === 0)
                      return { ok: false, message: searchRepair(input.query) } satisfies Output
                    // P8: recency × authority re-rank (bounded — see ranking.ts). A no-op when the hits
                    // share provenance and age.
                    const hits = MemoryRanking.rankHits(candidates, Date.now()).slice(0, k)
                    return { ok: true, message: formatHits(hits, renderID) } satisfies Output
                  }
                  case "resolve": {
                    const label = input.label.trim()
                    if (label === "") return { ok: false, message: "Give a subject label to resolve." } satisfies Output
                    const k = Math.max(1, Math.min(Math.trunc(input.k ?? 8), 16))
                    const found = yield* probe(
                      memory.search({
                        query: label,
                        k: Math.min(k * OVERFETCH, OVERFETCH_CAP),
                        scopes: access.scopes,
                        surface: "kb-tool",
                      }),
                    )
                    if (found.fault !== undefined)
                      return {
                        ok: false,
                        message: engineDown(`resolve "${label}"`, found.fault),
                      } satisfies Output
                    const candidates = (found.value ?? [])
                      .filter((hit) => hit.name?.trim().toLocaleLowerCase() === label.toLocaleLowerCase())
                      .slice(0, k)
                    if (candidates.length === 0)
                      return {
                        ok: false,
                        message: `No remembered subject is labelled "${label}". Search by description instead.`,
                      } satisfies Output
                    const rendered = formatHits(candidates, renderID)
                    return {
                      ok: true,
                      message:
                        candidates.length === 1
                          ? `Resolved "${label}":\n${rendered}`
                          : `"${label}" is ambiguous; choose one of these engine-resolved references:\n${rendered}`,
                    } satisfies Output
                  }
                  case "get": {
                    const storageID = resolveID(input.id)
                    if (storageID === undefined)
                      return { ok: false, message: unknownReference(input.id) } satisfies Output
                    const found = yield* probe(memory.get(storageID, access))
                    if (found.fault !== undefined)
                      return {
                        ok: false,
                        message: engineDown(`read "${displayReference(input.id)}"`, found.fault),
                      } satisfies Output
                    if (found.value === undefined || found.value === null)
                      return {
                        ok: false,
                        message: `No current memory is visible behind "${displayReference(input.id)}". Search or resolve it again.`,
                      } satisfies Output
                    const row = found.value
                    return { ok: true, message: formatHits([{ ...row, score: 1 }], renderID) } satisfies Output
                  }
                  case "predicates": {
                    if (input.id === undefined)
                      return {
                        ok: true,
                        message: `Allowed relationship types: ${KbClaim.RELATION_TYPE_NAMES.join(", ")}. Choose one; do not invent a predicate.`,
                      } satisfies Output
                    const storageID = resolveID(input.id)
                    if (storageID === undefined)
                      return { ok: false, message: unknownReference(input.id) } satisfies Output
                    const linked = yield* probe(
                      memory.neighbors(storageID, access, { k: Math.min(Math.max(1, Math.trunc(input.k ?? 64)), 256) }),
                    )
                    if (linked.fault !== undefined)
                      return {
                        ok: false,
                        message: engineDown(`inspect relationships for "${displayReference(input.id)}"`, linked.fault),
                      } satisfies Output
                    const types = [
                      ...new Set((linked.value ?? []).map((row) => row.type).filter(KbClaim.isRelationType)),
                    ]
                    return {
                      ok: true,
                      message:
                        types.length === 0
                          ? `No relationships are attached to "${displayReference(input.id)}" yet. Allowed types: ${KbClaim.RELATION_TYPE_NAMES.join(", ")}.`
                          : `Relationships attached to "${displayReference(input.id)}": ${types.join(", ")}`,
                    } satisfies Output
                  }
                  case "remember": {
                    const scope = MemoryAccess.scopeForWrite(sessionScope, agentID, input.scope)
                    // Embed on write so this memory is reachable by the vector leg later; degrades to
                    // an FTS-only memory when no device is configured.
                    const vector = yield* Effect.promise(() => KbEmbedder.embedOne(input.text))
                    const chatOnly = input.scope === "session" ? " — this chat only" : ""
                    /**
                     * 🔴 A NAMED remember is a CLAIM, and an unnamed one is not.
                     *
                     * The subject is what makes a statement governable: it is the entity the claim
                     * hangs off, and half of the key a correction is allowed to fire on. Without one
                     * there is nothing to file the statement against, so it stays an ordinary memory
                     * rather than a claim with a null subject pretending to be governed.
                     *
                     * ⚠️ Routing named remembers through the lifecycle also fixes something older:
                     * `remember` wrote a lone entity node with NO edge to anything, so every
                     * deliberate fact the user saved was an island in the very graph the tool
                     * describes as a knowledge GRAPH. It now lands attached to its subject.
                     */
                    if (input.name !== undefined && input.name.trim() !== "") {
                      const evidence: KbClaim.Evidence[] = [
                        {
                          kind: "message",
                          locator: context.assistantMessageID,
                          label: KbClaim.describeEvidence({ kind: "message", locator: "" }, new Date()),
                        },
                      ]
                      return yield* memory
                        .addClaim(
                          {
                            scope,
                            statement: input.text,
                            subject: input.name,
                            predicate: input.predicate ?? KbClaim.DEFAULT_PREDICATE,
                            relation: "staged",
                            evidence,
                            ...(vector === undefined ? {} : { embedding: vector }),
                          },
                          access,
                        )
                        .pipe(
                          Effect.map((result) => {
                            if (!result.ok || result.id === undefined)
                              return {
                                ok: false,
                                message:
                                  result.reason === "refused-scope"
                                    ? "That memory belongs to a place this chat can't write to."
                                    : "There was nothing to remember in that.",
                              } satisfies Output
                            if (result.deduped)
                              return {
                                ok: true,
                                message: `Already remembered (${renderID(result.id)})${chatOnly}.`,
                              } satisfies Output
                            const corrected =
                              result.superseded.length === 0
                                ? ""
                                : ` This replaces ${result.superseded.map(renderID).join(", ")}, kept in history — ` +
                                  `{"op":"history","id":"${renderID(result.id)}"} shows what changed.`
                            return {
                              ok: true,
                              message: `Remembered (${renderID(result.id)})${chatOnly}.${corrected}`,
                            } satisfies Output
                          }),
                          Effect.catch((error) =>
                            Effect.succeed({
                              ok: false,
                              message: `Couldn't save that memory right now (${error.reason}).`,
                            } satisfies Output),
                          ),
                        )
                    }
                    const id = "mem_" + ascending()
                    return yield* memory
                      .addMemory({
                        id,
                        kind: "entity",
                        text: input.text,
                        scope,
                        relation: "staged",
                        ...(vector === undefined ? {} : { embedding: vector }),
                      })
                      .pipe(
                        Effect.as({
                          ok: true,
                          message: `Remembered (${renderID(id)})${chatOnly}.`,
                        } satisfies Output),
                        Effect.catch((error) =>
                          Effect.succeed({
                            ok: false,
                            message: `Couldn't save that memory right now (${error.reason}).`,
                          } satisfies Output),
                        ),
                      )
                  }
                  case "history": {
                    // ⚠️ The SAME `access` as every other id-based op. History is the widest read the
                    // lifecycle adds — one id walks a whole chain — so it is the last place to reach
                    // for a wider reach "because it is only reading".
                    const storageID = resolveID(input.id)
                    if (storageID === undefined)
                      return { ok: false, message: unknownReference(input.id) } satisfies Output
                    const probed = yield* probe(memory.claimHistory(storageID, access))
                    if (probed.fault !== undefined)
                      return {
                        ok: false,
                        message: engineDown(`look up the history of "${displayReference(input.id)}"`, probed.fault),
                      } satisfies Output
                    const history = probed.value ?? null
                    if (history === null)
                      return {
                        ok: false,
                        message: `No memory behind "${displayReference(input.id)}" that you can see. Search or remember it again to get a current reference.`,
                      } satisfies Output
                    return { ok: true, message: formatHistory(history, renderID) } satisfies Output
                  }
                  case "forget": {
                    const storageID = resolveID(input.id)
                    if (storageID === undefined)
                      return { ok: false, message: unknownReference(input.id) } satisfies Output
                    return yield* (
                      input.secret ? memory.purge(storageID, access) : memory.invalidate(storageID, access)
                    ).pipe(
                      Effect.as({
                        ok: true,
                        message: input.secret
                          ? `Purged "${displayReference(input.id)}" — no history kept.`
                          : `Forgot "${displayReference(input.id)}" (kept in history; it won't surface in search).`,
                      } satisfies Output),
                      Effect.catch((error) =>
                        Effect.succeed({
                          ok: false,
                          message: `Couldn't forget "${displayReference(input.id)}" (${error.reason}).`,
                        } satisfies Output),
                      ),
                    )
                  }
                  case "neighbors": {
                    const storageID = resolveID(input.id)
                    if (storageID === undefined)
                      return { ok: false, message: unknownReference(input.id) } satisfies Output
                    const linked = yield* probe(memory.neighbors(storageID, access, { k: input.k ?? 10 }))
                    // "Nothing is linked to it yet" invites the model to build the link. An engine
                    // that never answered would have it building links into a store it can't reach.
                    if (linked.fault !== undefined)
                      return {
                        ok: false,
                        message: engineDown(`list what's linked to "${displayReference(input.id)}"`, linked.fault),
                      } satisfies Output
                    const rows = linked.value ?? []
                    if (rows.length === 0)
                      return {
                        ok: false,
                        message: `No memories linked to "${displayReference(input.id)}" yet. Create links with {"op":"relate","from":"ref_…","to":"ref_…","type":"…"}; references come from remember/search results.`,
                      } satisfies Output
                    return { ok: true, message: formatNeighbors(rows, renderID) } satisfies Output
                  }
                  case "path": {
                    const from = resolveID(input.from)
                    const to = resolveID(input.to)
                    if (from === undefined) return { ok: false, message: unknownReference(input.from) } satisfies Output
                    if (to === undefined) return { ok: false, message: unknownReference(input.to) } satisfies Output
                    const maxHops = Math.max(1, Math.min(Math.trunc(input.maxHops ?? 5), 8))
                    const found = yield* probe(memory.path(from, to, access, maxHops))
                    if (found.fault !== undefined)
                      return { ok: false, message: engineDown("find that path", found.fault) } satisfies Output
                    if (found.value === undefined || found.value === null)
                      return {
                        ok: false,
                        message: `No path connects "${displayReference(input.from)}" to "${displayReference(input.to)}" within ${maxHops} hops.`,
                      } satisfies Output
                    return { ok: true, message: formatPath(found.value, renderID) } satisfies Output
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
                      const ingestScope = MemoryAccess.scopeForWrite(sessionScope, agentID, input.scope)
                      const passages = KbChunk.chunk(KbChunk.stripGutenberg(raw))
                      if (passages.length === 0)
                        return { ok: false, message: `"${label}" has no readable text to ingest.` } satisfies Output
                      // A duplicate id does NOT fail on the real engine (measured) — it dedupes by primary
                      // key and addMemory still succeeds. Counting successful calls would claim we stored
                      // passages we did not, so count the actual delta.
                      //
                      // 🔴 …but a delta is only a FACT while the engine is answering. Both `stats()` calls
                      // used to degrade to `{total: 0}` and every write was `Effect.ignore`d, so an engine
                      // that was down produced `stored === 0` — byte-identical to "this document is already
                      // stored" — and the tool answered ok:true *"already in memory (412 passages, nothing
                      // new)"* about a document it had never read. The model's next `search` then said "No
                      // memories match", leaving it holding two contradictory statements about its own
                      // memory. Ruling 2's first clause, in the tool the whole KB surface runs through.
                      // So: write failures are COUNTED, and a `stats()` fault suppresses the delta
                      // arithmetic instead of feeding a fallback zero into it.
                      const before = yield* probe(memory.stats())
                      let failed = 0
                      let fault: string | undefined = before.fault
                      for (const text of passages) {
                        const written = yield* probe(
                          memory.addMemory({
                            id: passageID(label, text),
                            kind: "passage",
                            text,
                            name: label,
                            scope: ingestScope,
                            source: "ingest",
                            relation: "staged",
                          }),
                        )
                        if (written.fault !== undefined) {
                          failed += 1
                          fault ??= written.fault
                        }
                      }
                      const after = yield* probe(memory.stats())
                      fault ??= after.fault
                      const wrote = passages.length - failed
                      if (failed > 0)
                        return {
                          ok: false,
                          message:
                            wrote === 0
                              ? `${engineDown(`ingest "${label}"`, fault ?? "unknown")} None of its ${passages.length} passages were stored.`
                              : `Only ${wrote} of ${passages.length} passages from "${label}" were stored — the other ` +
                                `${failed} failed (${fault ?? "unknown"}). A search over it would be INCOMPLETE; ` +
                                `re-run the same ingest once memory is healthy — the ids are content-addressed, so ` +
                                `it fills the gap without duplicating what landed.`,
                        } satisfies Output
                      const tail =
                        `${ingestScope === "global" ? "" : " (this chat only)"}` +
                        `. Find things in it with {"op":"search","query":"…"}.`
                      // Every write landed but the COUNT check itself faulted: say what is known and name
                      // what is not, rather than inventing a delta out of a fallback zero.
                      if (before.fault !== undefined || after.fault !== undefined)
                        return {
                          ok: true,
                          message:
                            `Ingested "${label}" — all ${passages.length} passage${passages.length === 1 ? "" : "s"} ` +
                            `were written, but memory couldn't report how many were NEW (${fault ?? "unknown"})${tail}`,
                        } satisfies Output
                      const stored = Math.max(0, (after.value?.total ?? 0) - (before.value?.total ?? 0))
                      // Content-addressed ids make re-ingest idempotent: nothing new is not a failure.
                      if (stored === 0)
                        return {
                          ok: true,
                          message: `"${label}" is already in memory (${passages.length} passages, nothing new).`,
                        } satisfies Output
                      return {
                        ok: true,
                        message: `Ingested "${label}" as ${stored} searchable passage${stored === 1 ? "" : "s"}${tail}`,
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
                    const from = resolveID(input.from)
                    const to = resolveID(input.to)
                    if (from === undefined) return { ok: false, message: unknownReference(input.from) } satisfies Output
                    if (to === undefined) return { ok: false, message: unknownReference(input.to) } satisfies Output
                    const type = input.type
                    /**
                     * 🔴 `scope: "global"` here WAS the bridge NC-SEC-016 crossed — every relation was
                     * written shared, so joining a public memory to a private one made the private one
                     * reachable from every chat, and `neighbors` then handed over its text.
                     *
                     * The engine now DERIVES the stored scope from the endpoints and refuses pairs
                     * that no scope contains, so this value is advisory. What changed here is that
                     * the refusal is REPORTED: a relation that quietly did not happen teaches a model
                     * to believe a graph that is not there.
                     */
                    return yield* memory.addEdge({ from, to, type, scope: "global" }, access).pipe(
                      Effect.map((result) =>
                        result.ok
                          ? ({
                              ok: true,
                              message: `Linked ${displayReference(input.from)} —[${type}]→ ${displayReference(input.to)}${
                                result.scope === undefined || result.scope === "global"
                                  ? ""
                                  : ` (kept to ${result.scope}, the narrower of the two)`
                              }.`,
                            } satisfies Output)
                          : ({
                              ok: false,
                              message:
                                `Couldn't link those. Either an id doesn't exist, or the two memories are ` +
                                `private to different places — a link between them would make one of them ` +
                                `visible where it isn't. Both references must come from remember/search results.`,
                            } satisfies Output),
                      ),
                      Effect.catch((error) =>
                        Effect.succeed({
                          ok: false,
                          message: `Couldn't link those (${error.reason}). Both references must come from remember/search results.`,
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
