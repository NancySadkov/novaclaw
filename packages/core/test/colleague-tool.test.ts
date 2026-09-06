import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ColleagueNote } from "@novaclaw/core/session/colleague-note"
import { ColleagueTool } from "@novaclaw/core/tool/colleague"
import { SessionOrigin } from "@novaclaw/core/session/origin"
import type { AgentV2 } from "@novaclaw/core/agent"

// Colleagues talking to colleagues (AGENTS.md — the structural metaphor). The rules worth pinning
// are about STANDING: who may be addressed, and what the receiver is told about who is asking.

const agent = (over: { id: string } & Partial<Omit<AgentV2.Info, "id">>): AgentV2.Info =>
  ({ mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [], ...over }) as never

describe("who can be addressed", () => {
  const roster = [
    agent({ id: "nova", name: "Nova", title: "Chief Executive" }),
    agent({ id: "theron", name: "Theron", title: "Bookkeeper" }),
    agent({ id: "general", mode: "subagent" }),
    agent({ id: "title", hidden: true }),
  ]

  test("colleagues only — never the nameless staff, never the machinery", () => {
    // `general` is spawned per task and ends with it; `title` is plumbing. Neither has a chat to
    // receive anything, and addressing one would be talking to a process, not a person.
    expect(ColleagueTool.addressable(roster, "nova").map((a) => String(a.id))).toEqual(["theron"])
  })

  test("never yourself", () => {
    // A colleague messaging its own chat would append to the conversation it is currently having —
    // an infinite regress the model cannot see it is starting.
    expect(ColleagueTool.addressable(roster, "theron").map((a) => String(a.id))).toEqual(["nova"])
  })
})

describe("what the roster looks like to a model routing work", () => {
  test("id first, then who they are and what they own", () => {
    // The id is what `ask` takes, so it leads; the rest is what makes routing a decision rather than
    // a guess.
    const listing = ColleagueTool.formatRoster(
      [{ id: "theron", name: "Theron", title: "Bookkeeper", description: "Owns the ledger" }],
      "nova",
    )
    expect(listing).toBe("theron · Theron · Bookkeeper — Owns the ledger")
  })

  test("an empty roster says what to do instead of returning nothing", () => {
    // "No colleagues" rendered as an empty string reads as a broken tool, and a model that thinks a
    // tool is broken will try it again.
    expect(ColleagueTool.formatRoster([], "nova")).toContain("no colleagues yet")
  })

  test("a nameless colleague still lists under its id", () => {
    expect(ColleagueTool.formatRoster([{ id: "build" }], "nova")).toBe("build · build")
  })

  test("🔴 a PAUSED colleague is marked, not hidden", () => {
    // Marked, because asking one spends a hop on a message that never comes back — `permission.ts`
    // answers deny `*` for a paused agent — and the silence only surfaces 30 minutes later as a
    // stall notice.
    const listing = ColleagueTool.formatRoster([{ id: "wren", name: "Wren", paused: true }], "nova")
    expect(listing).toContain("wren")
    expect(listing).toContain("PAUSED")
  })

  test("…and HIDING one would be worse than listing it", () => {
    // The reason it is marked rather than filtered: a roster that omits a paused colleague reads as
    // "no such colleague", and the model hires a DUPLICATE — handing the new hire the paused one's
    // name and cabinet, which is the collateral that pausing replaced removal to avoid.
    const listing = ColleagueTool.formatRoster(
      [
        { id: "wren", name: "Wren", paused: true },
        { id: "edda", name: "Edda" },
      ],
      "nova",
    )
    expect(listing.split("\n")).toHaveLength(2)
  })

  test("an ACTIVE colleague carries no state marker", () => {
    // The control: a marker on every row would teach the model nothing.
    expect(ColleagueTool.formatRoster([{ id: "edda", name: "Edda" }], "nova")).not.toContain("PAUSED")
  })
})

describe("what a model sees when it inspects a colleague", () => {
  test("identity keeps the portrait as media instead of JSON text", () => {
    expect(
      ColleagueTool.toModelOutput({
        ok: true,
        message: "Edda's portrait is attached.",
        portrait: { mime: "image/png", data: "aW1hZ2U=", hash: "b".repeat(64) },
      } as never),
    ).toEqual([
      { type: "text", text: "Edda's portrait is attached." },
      { type: "file", data: "aW1hZ2U=", mime: "image/png", name: "colleague-portrait" },
    ])
  })
})

describe("who may staff the organization", () => {
  test("only the CEO hires and retires", () => {
    // Not a permission dial — the org chart itself. An officer that could hire would be a second
    // CEO, and an organization with two CEOs has none. The permission check still runs on top,
    // because "Nova may do this" and "this instance allows it now" are different questions.
    expect(ColleagueTool.mayStaff("nova")).toBe(true)
    expect(ColleagueTool.mayStaff("theron")).toBe(false)
    expect(ColleagueTool.mayStaff("")).toBe(false)
  })
})

describe("what the receiver is told about who is asking", () => {
  test("a PEER is a colleague, not a parent", () => {
    // The distinction is durable — it stays in the receiver's transcript — and calling a peer a
    // parent teaches the receiving model that the sender outranks it.
    const header = SessionOrigin.modelHeader({ via: "agent", sessionID: "ses_1", label: "nova", relation: "peer" })
    expect(header).toContain("colleague")
    expect(header).toContain("own judgement")
    expect(header).not.toContain("parent")
  })

  test("a delegation still reads as one", () => {
    // Sub-agents are genuinely subordinate: their work was assigned and their result goes back up.
    const header = SessionOrigin.modelHeader({ via: "agent", sessionID: "ses_1", label: "build" })
    expect(header).toContain("parent agent session")
    expect(header).toContain("delegated task")
  })

  test("the transcript badge names WHO and in what capacity", () => {
    // 🔴 Owner, 2026-08-21: *"the user who reads the chat should clearly see that the agent got
    // distracted and answered another agent"*. A bare name reads as a person writing in — the same
    // shape as the user's own messages — and the one fact a reader needs is that this turn was not
    // theirs. So the VERB is in the badge, not only the name.
    expect(SessionOrigin.badge({ via: "agent", sessionID: "ses_1", relation: "peer", label: "doriel" })).toMatchObject({
      label: "doriel asked",
      tone: "agent",
    })
    expect(SessionOrigin.badge({ via: "agent", sessionID: "ses_1", label: "nova" })).toMatchObject({
      label: "nova delegated",
    })
    // Nameless is still legible: a colleague whose label never made it through is not "unknown".
    expect(SessionOrigin.badge({ via: "agent", sessionID: "ses_1", relation: "peer" })).toMatchObject({
      label: "a colleague asked",
      tone: "agent",
    })
    expect(SessionOrigin.badge({ via: "agent", sessionID: "ses_1" })).toMatchObject({
      label: "a parent agent delegated",
    })
  })
})

// What the SENDER is told after a hand-off lands (`tool/colleague.ts`, the `ask` branch).
//
// 🔴 Measured on a live officer-to-officer hand-off 2026-08-21: told only that the colleague "answers
// there, in their own time", the sender told the USER *"Once they respond in their chat, I'll relay
// the answer to you"* — and at that moment nothing could deliver it. A tool result has to rule out
// the inference it does not support, not merely avoid asserting it.
//
// The route back exists now — the delivered message carries a return address
// (`session/colleague-note.ts`) — so the sentence has to do two jobs at once: promise the answer
// WILL come here, and forbid waiting for it. A turn that stalls on a peer is the defect principle 14
// forbids, and two officers stalling on each other is that defect twice.
//
// ⚠️ A source ledger, and it has to be: the behaviour it guards is a model's inference, which no
// deterministic test can assert. What CAN be checked is that both halves of the sentence survive the
// next edit — and "do not wait" is exactly what an editor trims as redundant.
describe("the hand-off result promises the answer AND forbids waiting", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "tool", "colleague.ts"),
    "utf8",
  )

  test("both delivery outcomes say the answer comes back here", () => {
    // Two arms — started and dormant — and a model that only ever reads one of them.
    expect((source.match(/arrive HERE|arrive here/g) ?? []).length).toBe(2)
  })

  test("and both forbid waiting for it", () => {
    expect((source.match(/[Dd]o (?:NOT|not) wait/g) ?? []).length).toBe(2)
  })

  test("NEGATIVE CONTROL: the reader would notice if the sentences went away", () => {
    expect(/arrive HERE/.test("Left it with theron. Their answer will arrive HERE as a message.")).toBe(true)
    expect(/arrive HERE|arrive here/.test("Left it with theron, in their own chat.")).toBe(false)
  })
})

// The RETURN ADDRESS the receiver gets (`session/colleague-note.ts`).
describe("a delivered peer message says how to answer it", () => {
  test("a question names the tool, the op and the recipient", () => {
    const note = ColleagueNote.compose({ message: "Where is the ledger?", from: "doriel", turn: "ask" })
    expect(note).toContain("Where is the ledger?")
    // All three, because a model told only "you may reply" has to guess the shape of the call.
    expect(note).toContain("`colleague`")
    expect(note).toContain('op "ask"')
    expect(note).toContain('colleague "doriel"')
    // …and that nobody is blocked on it: principle 14 is structural, so the note must not read as a
    // summons the receiver has to drop everything for.
    expect(note).toContain("not waiting")
  })

  test("an ANSWER stops the exchange instead of inviting another", () => {
    // The bound. Two symmetric notes would keep two colleagues talking to each other for as long as
    // the budget lasts, paid for by the user.
    const note = ColleagueNote.compose({ message: "Behind the clock.", from: "aris", turn: "answer" })
    expect(note).toContain("ANSWER")
    expect(note).toContain("Nothing further is expected")
    expect(note).not.toContain('op "ask", colleague "aris"')
  })

  test("the turn is decided by who spoke last, not by the caller", () => {
    expect(ColleagueNote.turnFor({ askedByRecipient: true })).toBe("answer")
    expect(ColleagueNote.turnFor({ askedByRecipient: false })).toBe("ask")
  })

  test("the colleague's own words come FIRST — the note is an appendix, not a preamble", () => {
    // A note that led would push the actual message below the fold of a model's attention, and the
    // message is the point.
    const note = ColleagueNote.compose({ message: "Two shillings.", from: "aris", turn: "ask" })
    expect(note.indexOf("Two shillings.")).toBe(0)
  })
})

// Asking a GROUP is one act with several subjects, and both facts below live inside the handler —
// invisible to a unit test, which is what a source ledger is for (same instrument as the delivery
// phrasing above).
describe("asking a group is ONE permission decision, over every colleague", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "tool", "colleague.ts"),
    "utf8",
  )
  const branch = source.slice(source.indexOf('input.op === "ask_group"'), source.indexOf("// Addressing a colleague"))

  test("the ledger's own instrument works", () => {
    // A slice that failed to find the branch would make every assertion below vacuous.
    expect(branch.length).toBeGreaterThan(500)
    expect(branch).toContain("deliverGroup")
  })

  test("the assert names EVERY colleague in one call", () => {
    // `permission.ts` folds a multi-resource request with `effects.includes("deny") ? "deny"`, so one
    // denied member denies the whole call — the all-or-nothing a group needs.
    expect(branch).toContain("resources: named")
  })

  test("it is NOT asserted per colleague in a loop", () => {
    // 🔴 The evaluator resolves project rules ONCE per evaluation on purpose, so two resources in one
    // call cannot be answered from either side of an edit. A loop re-reads that file per colleague
    // and puts the split back — and asks the user N times for one act.
    expect(branch).not.toMatch(/for \(const \w+ of named\)\s*\{[\s\S]{0,200}permission\.assert/)
  })

  test("colleagues it could not reach are REPORTED, never swallowed", () => {
    // The sender asked for a room and may have got a smaller one; only it can decide whether that
    // still answers the question.
    expect(branch).toContain("outcome.missing")
  })

  test("NEGATIVE CONTROL: the reader would notice if the assert went away", () => {
    expect(/resources: named/.test("yield* permission.assert({ action: name, resources: named })")).toBe(true)
    expect(/resources: named/.test("yield* permission.assert({ action: name, resources: [target] })")).toBe(false)
  })
})
