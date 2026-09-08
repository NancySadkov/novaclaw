import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KbChunk } from "./chunk"
import { KbClaim } from "./claim"
import { MemoryRanking } from "./ranking"
import { WasmMemory } from "./wasm-engine"

/**
 * THE CLAIM LIFECYCLE, against the engine that ships — the P1 acceptance gate, in one file:
 *
 *   • a stored correction leaves exactly ONE active answer retrievable,
 *   • the old assertion is preserved AND explained,
 *   • and no chat or colleague can read or mutate another's private claim by knowing its id.
 *
 * ⚠️ Every test here drives the real WASM store. The lifecycle's whole value is that supersession is
 * decided by stored identity rather than by prose, and a double that computes the identity the same
 * way the subject does would prove nothing about whether the STORE agrees.
 */

const DIM = 8
const ALICE = ["global", "session:alice"]
const BOB = ["global", "session:bob"]

let dir: string | undefined
let mem: WasmMemory | undefined

afterEach(async () => {
  await mem?.close()
  mem = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const open = async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-claim-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
  return mem
}

const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((row) => row.id)
/**
 * The ANSWERS in a recall result.
 *
 * ⚠️ A recall legitimately returns the subject ENTITY beside the claim — "Sofia" is a node whose name
 * matches a query about Sofia, and that is the graph working. The gate is about how many current
 * ANSWERS come back, so these assertions filter to claims rather than pretending the entity is not
 * there. A test that demanded an empty-but-for-one result would be asserting the store's shape, not
 * the lifecycle's guarantee.
 */
const answers = (rows: ReadonlyArray<{ id: string; kind: string }>) =>
  rows.filter((row) => row.kind === "claim").map((row) => row.id)

describe("a correction leaves exactly one active answer", () => {
  test("🔴 the new employer is retrievable and the old one is NOT", async () => {
    const engine = await open()
    const first = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Initech.",
    })
    const second = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme Robotics.",
    })

    expect(first.ok).toBe(true)
    expect(second.identified).toBe(true)
    expect(second.superseded).toEqual([first.id!])

    // The whole gate in one read: ONE answer to the question, and it is the current one.
    const hits = await engine.search({ query: "Sofia works", scopes: ["global"], k: 10 })
    expect(answers(hits)).toEqual([second.id!])
  }, 120_000)

  test("the retired claim is still THERE — enumeration and the graph keep it, only recall drops it", async () => {
    const engine = await open()
    const first = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Initech.",
    })
    const second = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme Robotics.",
    })

    const listed = await engine.list({ scopes: ["global"], kinds: ["claim"] })
    expect(ids(listed).sort()).toEqual([first.id!, second.id!].sort())
    const retired = listed.find((row) => row.id === first.id)!
    expect(retired.status).toBe("superseded")
    expect(retired.supersededBy).toBe(second.id!)
    // Immutable history: the old statement is untouched, not rewritten into the new one.
    expect(retired.text).toBe("Sofia works at Initech.")
  }, 120_000)

  test("🔴 history is SEARCHABLE, but only when a caller asks for it out loud", async () => {
    const engine = await open()
    const first = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Initech.",
    })
    await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme Robotics.",
    })
    // The default hides it — that is the separation. Naming the status is what reaches it, and the
    // privileged read is therefore visible at its call site rather than reached by omitting an
    // argument, which is the same shape as `MemoryAccess`.
    const retired = await engine.search({ query: "Sofia works", scopes: ["global"], statuses: ["superseded"] })
    expect(answers(retired)).toEqual([first.id!])
  }, 120_000)

  test("asking for the history explains the change, oldest included, with its evidence", async () => {
    const engine = await open()
    const first = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Initech.",
      evidence: [{ kind: "chat", locator: "msg_1" }],
    })
    const second = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme Robotics.",
      evidence: [{ kind: "chat", locator: "msg_2" }],
    })

    const history = await engine.claimHistory(second.id!)
    expect(history).not.toBeNull()
    expect(ids(history!.timeline)).toEqual([second.id!, first.id!])
    expect(history!.timeline[1]!.status).toBe("superseded")
    expect(history!.evidence.map((row) => row.locator).sort()).toEqual(["msg_1", "msg_2"])
    // Asked about the RETIRED one, history points forward to what answers the question now.
    const back = await engine.claimHistory(first.id!)
    expect(back!.current?.id).toBe(second.id!)
  }, 120_000)

  test("a restatement of the SAME fact dedupes rather than superseding itself", async () => {
    const engine = await open()
    const claim = { scope: "global", subject: "Sofia", predicate: "employer", statement: "Sofia works at Acme." }
    const first = await engine.addClaim(claim)
    const again = await engine.addClaim(claim)
    expect(again.id).toBe(first.id!)
    expect(again.deduped).toBe(true)
    expect(again.superseded).toEqual([])
    expect((await engine.list({ kinds: ["claim"] })).length).toBe(1)
  }, 120_000)

  test("🔴 re-asserting something already retired mints a NEW claim — history is never rewound", async () => {
    const engine = await open()
    const initech = "Sofia works at Initech."
    const first = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: initech,
    })
    const acme = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme.",
    })
    const backAgain = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: initech,
    })

    expect(backAgain.id).not.toBe(first.id!)
    expect(backAgain.superseded).toEqual([acme.id!])
    // The FIRST one stays retired, pointing at the correction that retired it — not silently revived.
    const rows = await engine.list({ kinds: ["claim"] })
    expect(rows.find((row) => row.id === first.id)!.status).toBe("superseded")
    expect(rows.find((row) => row.id === first.id)!.supersededBy).toBe(acme.id!)
    expect(answers(await engine.search({ query: "Sofia works", scopes: ["global"] }))).toEqual([backAgain.id!])
  }, 120_000)
})

describe("supersession fires ONLY on a validated closed identity", () => {
  test("🔴 a MULTI-valued predicate accumulates — the two claims coexist as a conflict to reconcile", async () => {
    const engine = await open()
    const rust = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "knows",
      statement: "Sofia knows Rust.",
    })
    const ts = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "knows",
      statement: "Sofia knows TypeScript.",
    })
    expect(ts.superseded).toEqual([])
    expect(ts.identified).toBe(false)
    expect(answers(await engine.search({ query: "Sofia knows", scopes: ["global"] })).sort()).toEqual(
      [rust.id!, ts.id!].sort(),
    )
  }, 120_000)

  test("🔴 an INVENTED predicate retires nothing, however similar the sentences read", async () => {
    const engine = await open()
    const old = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "works_at_currently",
      statement: "Sofia works at Initech.",
    })
    const now = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "works_at_currently",
      statement: "Sofia works at Acme.",
    })
    expect(old.identified).toBe(false)
    expect(now.superseded).toEqual([])
    // Both stand. That is the designed outcome: the harness declines to guess.
    expect(answers(await engine.search({ query: "Sofia works", scopes: ["global"] })).length).toBe(2)
  }, 120_000)

  test("the same subject and predicate in a DIFFERENT scope is a different question", async () => {
    const engine = await open()
    const household = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Initech.",
    })
    const cabinet = await engine.addClaim({
      scope: "session:alice",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme.",
    })
    expect(cabinet.superseded).toEqual([])
    expect((await engine.list({ kinds: ["claim"] })).every((row) => row.status === "active")).toBe(true)
    expect(household.id).not.toBe(cabinet.id!)
  }, 120_000)
})

describe("the claim is filed against its subject and its evidence", () => {
  test("`Entity <-subject- Claim -supported_by-> Source` is really in the graph", async () => {
    const engine = await open()
    const claim = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme.",
      evidence: [{ kind: "file", locator: "people/sofia.md" }],
    })
    const linked = await engine.neighbors(claim.id!, { scopes: ["global"] })
    expect(linked.map((row) => row.type).sort()).toEqual([KbClaim.SUBJECT_EDGE, KbClaim.SUPPORTED_BY_EDGE].sort())
    // The subject edge lands on the SHARED entity node — the same id extraction and ingestion use, so
    // a claim about Sofia and a document about Sofia are one node, not two.
    expect(linked.some((row) => row.id === KbChunk.entityID("global", "Sofia"))).toBe(true)
  }, 120_000)

  test("🔴 the SAME file cited from two cabinets: both claims keep their evidence", async () => {
    const engine = await open()
    const file = "src/auth.ts"
    const alices = await engine.addClaim({
      scope: "session:alice",
      subject: "auth",
      predicate: "path",
      statement: "Alice's note about the auth entry point.",
      evidence: [{ kind: "file", locator: file }],
      scopes: ALICE,
    })
    const bobs = await engine.addClaim({
      scope: "session:bob",
      subject: "auth",
      predicate: "path",
      statement: "Bob's note about the auth entry point.",
      evidence: [{ kind: "file", locator: file }],
      scopes: BOB,
    })

    // Before the source id carried the scope, the second claim landed pointing at a node in a scope it
    // does not share — `addEdge` refuses two different private scopes, so the edge was silently
    // dropped and the claim LOOKED cited while citing nothing.
    for (const [claim, scopes] of [
      [alices, ALICE],
      [bobs, BOB],
    ] as const)
      expect(
        (await engine.neighbors(claim.id!, { scopes })).some((row) => row.type === KbClaim.SUPPORTED_BY_EDGE),
      ).toBe(true)

    // …and one moved file flags both, each within its own cabinet.
    expect(await engine.reviewEvidence(file, { scopes: ALICE })).toBe(1)
    expect(await engine.reviewEvidence(file, { scopes: BOB })).toBe(1)
  }, 120_000)

  test("🔴 a raw passage is SOURCE MATERIAL — it does not outrank the claim it merely echoes", async () => {
    const engine = await open()
    const claim = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme Robotics.",
      evidence: [{ kind: "chat", locator: "msg_1" }],
    })
    // An ingested manual is HUNDREDS of rows like this one, each a plausible lexical match. At equal
    // weight they bury every deliberate fact in the store, which is the whole reason a passage is
    // demoted rather than treated as an answer.
    for (let n = 0; n < 20; n++)
      await engine.addMemory({
        id: `handbook_${n}`,
        kind: "passage",
        text: "Sofia works at Acme Robotics; Sofia works there per the Acme staff handbook, section " + n,
        name: "handbook",
        scope: "global",
        source: "ingest",
      })

    const hits = await engine.search({ query: "Sofia works Acme", scopes: ["global"], k: 10 })
    // The passages DO win on raw retrieval — that is the condition this weighting exists for, and
    // asserting it here is what stops the test passing for the wrong reason.
    expect(hits[0]!.kind).toBe("passage")
    const ranked = MemoryRanking.rankHits(hits, Date.now())
    expect(ranked[0]!.id).toBe(claim.id!)
  }, 120_000)
})

describe("raw passages are source material, not the answer", () => {
  test("🔴 a flood of passages cannot take the whole page while anything else competes", async () => {
    const engine = await open()
    const claim = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme Robotics.",
    })
    for (let n = 0; n < 30; n++)
      await engine.addMemory({
        id: `bulk_${n}`,
        kind: "passage",
        text: "Sofia works at Acme Robotics; Sofia works there per the Acme staff handbook, section " + n,
        name: "handbook",
        scope: "global",
        source: "ingest",
      })
    const hits = await engine.search({ query: "Sofia works Acme", scopes: ["global"], k: 8 })
    // The guarantee is that NO non-passage is displaced: the claim and its subject entity are both on
    // the page. Passages then fill whatever is left over — the page is still full, so the cap costs
    // the caller nothing.
    expect(hits.some((hit) => hit.id === claim.id)).toBe(true)
    expect(hits.some((hit) => hit.id === KbChunk.entityID("global", "Sofia"))).toBe(true)
    expect(hits.length).toBe(8)
  }, 120_000)

  test("⚠️ …and the cap RELEASES when passages are all there is — `ingest then search` still works", async () => {
    const engine = await open()
    for (let n = 0; n < 30; n++)
      await engine.addMemory({
        id: `manual_${n}`,
        kind: "passage",
        text: "The siege crab moults every third season and is hostile during the moult, page " + n,
        name: "monster manual",
        scope: "global",
        source: "ingest",
      })
    const hits = await engine.search({ query: "siege crab moults", scopes: ["global"], k: 8 })
    expect(hits.length).toBe(8)
    expect(hits.every((hit) => hit.kind === "passage")).toBe(true)
  }, 120_000)
})

describe("evidence that MOVES flags the claim, and never destroys it", () => {
  test("🔴 needs_review, deterministically, via the stored source — not by matching text", async () => {
    const engine = await open()
    const cited = await engine.addClaim({
      scope: "global",
      subject: "auth",
      predicate: "path",
      statement: "The auth entry point is the login handler.",
      evidence: [{ kind: "file", locator: "src/auth.ts" }],
    })
    // A claim that MENTIONS the path but does not cite it. A prose-matching corrector would flag this
    // one too; the traversal does not, because nothing links it to that source.
    const mentions = await engine.addClaim({
      scope: "global",
      subject: "onboarding",
      predicate: "about",
      statement: "The onboarding doc tells new joiners to read src/auth.ts first.",
    })

    expect(await engine.reviewEvidence("src/auth.ts")).toBe(1)
    const rows = await engine.list({ kinds: ["claim"] })
    expect(rows.find((row) => row.id === cited.id)!.status).toBe("needs_review")
    expect(rows.find((row) => row.id === mentions.id)!.status).toBe("active")
  }, 120_000)

  test("a flagged claim is still RETRIEVABLE — a moved citation is not evidence the fact is false", async () => {
    const engine = await open()
    const claim = await engine.addClaim({
      scope: "global",
      subject: "auth",
      predicate: "path",
      statement: "The auth entry point is the login handler.",
      evidence: [{ kind: "file", locator: "src/auth.ts" }],
    })
    await engine.reviewEvidence("src/auth.ts")
    expect(answers(await engine.search({ query: "auth entry point", scopes: ["global"] }))).toEqual([claim.id!])
  }, 120_000)

  test("archiving DOES take it out of recall, and history still explains it", async () => {
    const engine = await open()
    const claim = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme.",
    })
    expect(await engine.setClaimStatus(claim.id!, "archived")).toBe(true)
    expect(answers(await engine.search({ query: "Sofia works", scopes: ["global"] }))).toEqual([])
    expect((await engine.claimHistory(claim.id!))!.claim.status).toBe("archived")
    // …and it is reversible.
    expect(await engine.setClaimStatus(claim.id!, "active")).toBe(true)
    expect(answers(await engine.search({ query: "Sofia works", scopes: ["global"] }))).toEqual([claim.id!])
  }, 120_000)

  test("🔴 a SUPERSEDED claim cannot be restored — that would leave two current answers to one question", async () => {
    const engine = await open()
    const first = await engine.addClaim({
      scope: "global",
      subject: "Tam",
      predicate: "employer",
      statement: "Tam works at Initech.",
    })
    const second = await engine.addClaim({
      scope: "global",
      subject: "Tam",
      predicate: "employer",
      statement: "Tam works at Acme.",
    })
    expect(second.superseded).toEqual([first.id!])

    // Setting `superseded` was already refused at the type level. This is the OTHER direction, which
    // was not: the retired row keeps its `superseded_by` pointer and its `supersedes` edge, so
    // flipping it back to `active` produces a claim that is simultaneously current and replaced.
    expect(await engine.setClaimStatus(first.id!, "active")).toBe(false)
    expect(await engine.setClaimStatus(first.id!, "archived")).toBe(false)
    expect((await engine.claimHistory(first.id!))!.claim.status).toBe("superseded")
    // The property that matters, stated as the reader would ask it: ONE answer comes back.
    expect(answers(await engine.search({ query: "Tam works", scopes: ["global"] }))).toEqual([second.id!])

    // …and the control: an ordinary active claim in the same store still archives, so the refusal
    // above is about the claim's lifecycle state and not about the operation being broken.
    expect(await engine.setClaimStatus(second.id!, "archived")).toBe(true)
  }, 120_000)
})

describe("exact identifiers stay reachable when similarity is weak", () => {
  test("🔴 a claim is found by its own id, among many rows that all read alike", async () => {
    const engine = await open()
    const target = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme.",
    })
    for (let n = 0; n < 12; n++)
      await engine.addMemory({
        id: `noise_${n}`,
        kind: "passage",
        text: "Employment records and staff directory notes for the company.",
        name: "handbook",
        scope: "global",
        source: "ingest",
      })
    const hits = await engine.search({ query: `tell me about ${target.id}`, scopes: ["global"], k: 5 })
    expect(hits[0]!.id).toBe(target.id!)
  }, 120_000)

  test("🔴 an exact id beats a row that tops BOTH fuzzy legs at once", async () => {
    const engine = await open()
    const claim = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme Robotics.",
    })
    // The decoy is the best possible fuzzy match: identical to the query vector AND the only keyword
    // match. It therefore scores top rank in both legs, which is the ceiling similarity can reach —
    // and the exact leg has to out-weigh that ceiling, not merely tie with one leg.
    const vector = [1, 0, 0, 0, 0, 0, 0, 0]
    await engine.addMemory({
      id: "decoy_both_legs",
      kind: "episode",
      text: "crabs crabs crabs",
      scope: "global",
      embedding: vector,
    })
    const hits = await engine.search({
      query: `${claim.id} crabs`,
      embedding: vector,
      scopes: ["global"],
      k: 5,
    })
    expect(hits[0]!.id).toBe(claim.id!)
  }, 120_000)

  test("a source is found FIRST by its exact locator, among rows FTS likes better", async () => {
    const engine = await open()
    await engine.addClaim({
      scope: "global",
      subject: "auth",
      predicate: "path",
      statement: "The entry point is the login handler.",
      evidence: [{ kind: "file", locator: "packages/core/src/auth.ts" }],
    })
    // Rows stuffed with the path's own words. FTS splits a path into exactly these tokens, so the
    // decoys are the better keyword match and the exact leg is the only thing that can beat them.
    for (let n = 0; n < 12; n++)
      await engine.addMemory({
        id: `decoy_${n}`,
        kind: "passage",
        text: "packages core src auth ts packages core src auth ts notes " + n,
        name: "packages core src auth ts",
        scope: "global",
        source: "ingest",
      })
    const hits = await engine.search({ query: "packages/core/src/auth.ts", scopes: ["global"], k: 5 })
    expect(hits[0]!.evidence).toBe("packages/core/src/auth.ts")
  }, 120_000)
})

describe("🔴 knowing an id is not authority over it", () => {
  const alicesClaim = async (engine: WasmMemory) =>
    engine.addClaim({
      scope: "session:alice",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Initech.",
      scopes: ALICE,
    })

  test("another chat cannot READ the history of a private claim it knows the id of", async () => {
    const engine = await open()
    const claim = await alicesClaim(engine)
    expect(await engine.claimHistory(claim.id!, { scopes: BOB })).toBeNull()
    // …and the owner still can. A containment test that only proves refusal has not shown the
    // product still works.
    expect((await engine.claimHistory(claim.id!, { scopes: ALICE }))!.claim.id).toBe(claim.id!)
  }, 120_000)

  test("another chat cannot ARCHIVE it either", async () => {
    const engine = await open()
    const claim = await alicesClaim(engine)
    expect(await engine.setClaimStatus(claim.id!, "archived", { scopes: BOB })).toBe(false)
    expect((await engine.claimHistory(claim.id!, { scopes: ALICE }))!.claim.status).toBe("active")
  }, 120_000)

  test("🔴 nor WRITE into another chat's scope — the door supersession would otherwise open", async () => {
    const engine = await open()
    const claim = await alicesClaim(engine)
    // Bob names Alice's scope directly. Without the write-side check this would supersede her claim
    // without Bob ever needing its id.
    const attempt = await engine.addClaim({
      scope: "session:alice",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Bob's company.",
      scopes: BOB,
    })
    expect(attempt.ok).toBe(false)
    expect(attempt.reason).toBe("refused-scope")
    expect((await engine.claimHistory(claim.id!, { scopes: ALICE }))!.claim.status).toBe("active")
  }, 120_000)

  test("a correction in Bob's OWN scope leaves Alice's answer standing", async () => {
    const engine = await open()
    const claim = await alicesClaim(engine)
    await engine.addClaim({
      scope: "session:bob",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme.",
      scopes: BOB,
    })
    expect((await engine.claimHistory(claim.id!, { scopes: ALICE }))!.claim.status).toBe("active")
    expect(answers(await engine.search({ query: "Sofia works", scopes: ALICE }))).toEqual([claim.id!])
  }, 120_000)

  test("flagging evidence cannot reach across the boundary either", async () => {
    const engine = await open()
    const claim = await engine.addClaim({
      scope: "session:alice",
      subject: "auth",
      predicate: "path",
      statement: "The entry point is the login handler.",
      evidence: [{ kind: "file", locator: "src/auth.ts" }],
      scopes: ALICE,
    })
    expect(await engine.reviewEvidence("src/auth.ts", { scopes: BOB })).toBe(0)
    expect((await engine.claimHistory(claim.id!, { scopes: ALICE }))!.claim.status).toBe("active")
    expect(await engine.reviewEvidence("src/auth.ts", { scopes: ALICE })).toBe(1)
  }, 120_000)
})

describe("the Memory app's lenses, and what consolidation may promote", () => {
  test("`list` takes a lifecycle lens — Current and History are the same store, read twice", async () => {
    const engine = await open()
    const first = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Initech.",
    })
    const second = await engine.addClaim({
      scope: "global",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme.",
    })
    expect(ids(await engine.list({ kinds: ["claim"], statuses: ["active"] }))).toEqual([second.id!])
    expect(ids(await engine.list({ kinds: ["claim"], statuses: ["superseded"] }))).toEqual([first.id!])
    // …and with no lens the app sees everything, which is what "what do you remember?" means.
    expect((await engine.list({ kinds: ["claim"] })).length).toBe(2)
  }, 120_000)

  test("🔴 consolidation does NOT promote a claim — a twin would have no identity to be corrected by", async () => {
    const engine = await open()
    const claim = await engine.addClaim({
      scope: "session:alice",
      subject: "Sofia",
      predicate: "employer",
      statement: "Sofia works at Acme.",
      source: "auto-extract",
    })
    await engine.addMemory({
      id: "ep_1",
      kind: "episode",
      text: "an ordinary extracted fact",
      scope: "session:alice",
      source: "auto-extract",
    })
    // The episode is promoted; the claim is left where it is, still active and still governed.
    expect(await engine.consolidate()).toBe(1)
    const rows = await engine.list({ kinds: ["claim"], scopes: ["global"] })
    expect(rows).toEqual([])
    expect((await engine.claimHistory(claim.id!))!.claim.status).toBe("active")
  }, 120_000)
})

describe("the edge's reach is its ENDPOINTS' — reported, not stored", () => {
  test("a link to a private memory keeps the narrower reach, and says so", async () => {
    const engine = await open()
    await engine.addMemory({ id: "G", kind: "entity", text: "shared", scope: "global" })
    await engine.addMemory({ id: "S", kind: "entity", text: "alice only", scope: "session:alice" })
    const made = await engine.addEdge({ from: "G", to: "S", type: "rel", scope: "global" })
    // The derivation survived the column's removal: the caller can still SEE what reach it got, which
    // is what a stored-but-unread value never allowed.
    expect(made).toEqual({ ok: true, scope: "session:alice" })
    // And the reach is real, enforced on the NODES.
    expect(await engine.neighbors("G", { scopes: BOB })).toEqual([])
    expect(ids(await engine.neighbors("G", { scopes: ALICE }))).toEqual(["S"])
  }, 120_000)

  test("two different private scopes are still REFUSED", async () => {
    const engine = await open()
    await engine.addMemory({ id: "A", kind: "entity", text: "alice", scope: "session:alice" })
    await engine.addMemory({ id: "B", kind: "entity", text: "bob", scope: "session:bob" })
    expect(await engine.addEdge({ from: "A", to: "B", type: "rel", scope: "global" })).toEqual({ ok: false })
  }, 120_000)
})
