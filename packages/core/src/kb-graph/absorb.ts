export * as KbAbsorb from "./absorb"

import { Context, Effect, Stream } from "effect"
import { LLM, LLMClient, LLMEvent, Message, SystemPart, type Model } from "@novaclaw/llm"
import { Log } from "@novaclaw/schema/log"
import { Flag } from "../flag/flag"
import { KbChunk } from "./chunk"
import * as MemoryAccess from "./memory-access"
import type { MemoryClient } from "./memory-client"
import { SessionExtract } from "../session/runner/extract"
import { ReasoningBudget } from "../session/runner/reasoning-budget"

/**
 * ABSORBING a document — turning stored passages into things the graph can connect.
 *
 * 🔴 The defect this closes. `ingest` chunked a document and stored each chunk as a `passage` named
 * after its SOURCE FILE, and stopped. Measured on a real store: 303 nodes carrying ONE distinct
 * name, so a monster manual had no `Siege Crab` node and never would. The graph view was drawn as
 * though a knowledge graph existed behind it. Structure came first (`d0506cdb1` hung every passage
 * off a document entity); this is the half that reads what a passage SAYS.
 *
 * ⚠️ **The name discipline is inherited deliberately, not re-invented.** `SessionExtract.SYSTEM`'s
 * wording was measured on 2026-07-20: demanding a CONCRETE thing copied from the source, rather than
 * a "subject", moved linkable pairs from 5% to 76% with entity recall unchanged. A document prompt
 * that softened that back into "topics" would rebuild the unlinkable graph this exists to replace,
 * and the regression would look like a prompt-tuning preference rather than a measured loss.
 */
export const SYSTEM =
  "You extract the THINGS a passage of a document is about, for later recall. Output ONLY a JSON " +
  'array of objects like {"name":"<the specific thing>","text":"<one standalone fact about it>"}. ' +
  "The `name` must be the CONCRETE thing itself, copied from the passage as it appears there — a " +
  "creature, person, place, item, rule, mechanic, company, or technology " +
  '(e.g. "Siege Crab", "Baldur\'s Gate", "Armor Class", "TypeScript"). NEVER write a category, a ' +
  'role, or a description as the name (not "a monster", not "Chapter 3", not "Combat Rules ' +
  'Overview") — name the thing, not what kind of thing it is. Emit a SEPARATE object for EVERY such ' +
  "thing the passage describes. Write each `text` as a self-contained sentence that makes sense with " +
  "no other context, because the passage will not be shown beside it. EXCLUDE page furniture, " +
  "headers, tables of contents, and anything that is not about a thing. " +
  // ⚠️ Measured 2026-08-12: 32 of 88 extracted names were stat-block FIELD LABELS — "Str", "Fort",
  // "Challenge Rating", "Treasure", "Level Adjustment". The clause above already said to skip page
  // furniture, and it did not land, because in a stat block the furniture IS the structure: the
  // labels look like content. Naming the case explicitly is what the conversational prompt needed
  // too, and its rewrite moved linkable pairs 5% -> 76%.
  "⚠️ A table or stat block's LABELS are not things. Skip the names of attributes, scores, saves and " +
  'record fields — e.g. "Strength", "Dex", "Fort", "Will save", "Challenge Rating", "Level ' +
  'Adjustment", "Treasure", "Advancement", "Full Attack", "Organization" — because they name WHERE A ' +
  "NUMBER LIVES, not anything in the world. Extract the creature, place, item, feat or ability the " +
  "block is ABOUT, and the named abilities it has. If the passage describes nothing nameable, output " +
  "exactly []."

/** One passage's worth of extraction, already parsed. */
export interface Absorbed {
  readonly name: string
  readonly text: string
}

/**
 * How much REASONING one passage may spend.
 *
 * Owner ruling, 2026-08-12: memory organisation runs as a low-priority subthread with a limited
 * context budget — *"that ensures memory management organisation doesn't slow down the model's reply,
 * while the memory management quality won't be degraded by necessity to act fast"* — and *"if the
 * model fails with said thinking budget, we just disable thinking, like we do with session title
 * generation."*
 *
 * Larger than the title budget (128) because naming the things in 900 characters of prose is a
 * harder judgement than naming one conversation, and quality is the whole point of doing this work
 * off the reply path. ⚠️ A first value, not a measured one — it wants the same treatment the title
 * budget got.
 */
export const ABSORB_REASONING_BUDGET = ((): number => {
  // ⚠️ A KNOB, because the value is unmeasured. The recorded lesson from the 2026-08-12 chat-mode
  // eval is exact: a thinking model read 18/24 at a 300-token budget and 24/24 at 2048, so a budget
  // reported without being swept is a number about the harness, not the model.
  const raw = Number(Flag.NOVACLAW_KB_ABSORB_BUDGET)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 512
})()

/**
 * Ask the model what one passage is about.
 *
 * ⚠️ **Thinking is ALLOWED, within a budget, and only disabled on failure** — the opposite of what
 * this first did. `ReasoningBudget` counts reasoning tokens live, nudges at 70% and 100% of the
 * budget, and its mechanical hard stop re-issues the turn with thinking structurally disabled. That
 * is the owner's ruling and it is the same shape session-title generation already ships.
 *
 * Measured 2026-08-12 on qwen3.6-35b with thinking OFF: extraction named `"Special Attacks and
 * Special Qualities"` (a section heading) and `"creature's primary attack damage"` (a description),
 * both of which this prompt explicitly forbids. Suppressing thinking to guarantee an answer bought a
 * cheap answer, and this pass is off the reply path precisely so it does not have to.
 *
 * ⛔ No `UtilityCap` ladder on top. `ReasoningBudget` already owns a bounded multi-phase recovery for
 * the empty-completion case; stacking a second retry loop is two recoveries racing over one turn,
 * which is how a bounded thing becomes unbounded (see `maintenance.ts`'s title pass, same reasoning).
 */
export const extractPassage = Effect.fn("KbAbsorb.extractPassage")(function* (input: {
  readonly llm: Context.Service.Shape<typeof LLMClient.Service>
  readonly model: Model
  readonly text: string
}) {
  const chunks: string[] = []
  yield* ReasoningBudget.stream({
    request: LLM.request({
      model: input.model,
      system: [SystemPart.make(SYSTEM)],
      messages: [Message.user(input.text)],
      tools: [],
      generation: { maxTokens: 2048 },
    }),
    stream: (next) => input.llm.stream(next),
    budget: ABSORB_REASONING_BUDGET,
  }).pipe(
    Stream.runForEach((event) => {
      if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
      return Effect.void
    }),
  )
  // `parseExtraction` is shared with the conversational path: same tolerance for fences and prose,
  // same dedup, same never-throws contract. A second parser would drift from it silently.
  return SessionExtract.parseExtraction(chunks.join(""), 20).filter(
    (fact): fact is Absorbed => typeof fact.name === "string" && fact.name.trim() !== "",
  )
})

/**
 * Write what a passage yielded: an ENTITY per named thing, an episode-free `mentions` edge from the
 * passage, and the fact itself as text on the entity's own memory.
 *
 * ⚠️ Entities are keyed by `KbChunk.entityID`, the SAME function the conversational path uses. That
 * is the whole point: a creature named in a rulebook and the same creature mentioned in a chat land
 * on ONE node. Two formulas would mint two, which is the fragmentation this program removed.
 */
export const writeAbsorbed = Effect.fn("KbAbsorb.writeAbsorbed")(function* (input: {
  readonly memory: MemoryClient.Interface
  readonly scope: string
  readonly passageID: string
  readonly facts: ReadonlyArray<Absorbed>
}) {
  for (const fact of input.facts) {
    const id = KbChunk.entityID(input.scope, fact.name)
    yield* input.memory
      .addMemory({
        id,
        kind: "entity",
        text: fact.text,
        name: fact.name,
        scope: input.scope,
        source: "ingest",
        relation: "staged",
      })
      .pipe(Effect.ignore) // duplicate id = this entity is already known
    // After the node, never before: an edge needs both endpoints to exist.
    yield* input.memory
      // SYSTEM: absorption runs on the instance's own behalf, joining a passage to what it says.
      .addEdge(
        { from: input.passageID, to: id, type: "mentions", scope: input.scope, source: "ingest" },
        MemoryAccess.system(),
      )
      .pipe(Effect.ignore)
  }
  return input.facts.length
})

/**
 * Absorb a bounded batch of passages.
 *
 * ⚠️ `limit` is REQUIRED and has no default. Every passage costs a model call, and a document is
 * hundreds of passages — a default would let a caller spend an unbounded amount of someone's model
 * budget by omitting an argument. Making it explicit is the whole budget mechanism for now.
 *
 * ⚠️ Sequential, deliberately. Concurrency here would multiply peak memory on the local model and
 * race the same entity ids into `addMemory` from several fibers; the wall-clock cost is not the
 * scarce thing when this runs detached from the request.
 *
 * Best-effort per passage: one passage that fails must not abandon the rest, because the caller has
 * already returned and nobody is watching to retry it.
 */
export const absorb = Effect.fn("KbAbsorb.absorb")(function* (input: {
  readonly llm: Context.Service.Shape<typeof LLMClient.Service>
  readonly model: Model
  readonly memory: MemoryClient.Interface
  readonly scope: string
  readonly passages: ReadonlyArray<{ readonly id: string; readonly text: string }>
  readonly limit: number
}) {
  let entities = 0
  let done = 0
  for (const passage of input.passages.slice(0, Math.max(0, input.limit))) {
    const facts = yield* extractPassage({ llm: input.llm, model: input.model, text: passage.text }).pipe(
      Effect.catchCause((cause) =>
        Log.event("kb.absorb.passage.failed", { "kb.cause": Log.fault(cause) }).pipe(Effect.as([] as Absorbed[])),
      ),
    )
    entities += yield* writeAbsorbed({
      memory: input.memory,
      scope: input.scope,
      passageID: passage.id,
      facts,
    })
    done++
  }
  return { passages: done, entities }
})
