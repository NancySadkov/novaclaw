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

  /**
   * 🔴 **The postures are not colleagues, and this tool used to offer them** (owner, 2026-09-27, on a
   * live listing: `build · build · The default agent…` and `plan · plan · Plan mode…`).
   *
   * `AgentV2.isColleague` has excluded `POSTURE_IDS` since 2026-08-22 — measured against 54 live
   * `build` chats on the owner's own instance — and every UI surface reads it. This function was a
   * hand-rolled subset that kept only the `subagent` and `hidden` clauses, so the `colleague` tool was
   * the one door offering to hand work to a permission mode. That is worse than noise: a posture has
   * no `colleague` tool, so `ask` spends a hop on a message nothing can answer.
   */
  test("🔴 build and plan are NOT colleagues, whatever their mode says", () => {
    const postures = [
      agent({ id: "build", name: "Builder", title: "Task agent", mode: "primary" }),
      agent({ id: "plan", name: "Planner", title: "Planning agent", mode: "primary" }),
    ]
    // `mode: "primary"` and not hidden — the exact shape that leaked.
    expect(ColleagueTool.addressable(postures, "nova")).toEqual([])
    // ⚠️ Through `addressable`, not straight into `formatRoster`. `formatRoster` is a FORMATTER: it
    // prints whatever it is handed, and the two are separate seams on purpose. Feeding it postures
    // directly would be asserting that a filter the tool does not own lives in the printer — and the
    // leak the owner pasted was exactly that filter being absent at the call site.
    expect(ColleagueTool.formatRoster(ColleagueTool.addressable(postures, "nova"), "nova")).toContain(
      "no colleagues yet",
    )
  })

  /**
   * 🔴 **A CHAT-ONLY colleague is not an officer, and Xenia was in the listing** (owner, 2026-09-27:
   * `xenia · Xenia · Companion — Xenia, Companion.`). She runs with no tools, no memory and no harness
   * prompt: a place to talk to the model, not someone work can be handed to. The owning human is
   * `kind: "human"` and is hidden already; this is the arm that survives a user unhiding them.
   *
   * `shortChat` is honoured too, because that is the older spelling and rows written before `kind`
   * existed still carry it — the classification has ONE reader (`AgentV2.kindOf`) precisely so a second
   * hand-written stance fallback cannot appear beside it.
   */
  test("Chat stays out of the tool roster and the human owner is addressable", () => {
    const notOfficers = [
      agent({ id: "xenia", name: "Xenia", title: "Companion", shortChat: true }),
      agent({ id: "mirror", name: "Mirror", title: "Companion", kind: "chat" }),
      agent({ id: "owner", name: "Owner", title: "Instance Owner", kind: "human" }),
    ]
    expect(ColleagueTool.addressable(notOfficers, "nova").map((item) => String(item.id))).toEqual(["owner"])
  })

  test("…and the control: a full officer of the same kinds is still addressable", () => {
    // Without this, a `kindOf` typo that returned "chat" for everything would pass every case above.
    const officer = agent({ id: "daedalus", name: "Daedalus", title: "Engineer" })
    expect(ColleagueTool.addressable([officer], "nova").map((a) => String(a.id))).toEqual(["daedalus"])
  })

  /**
   * ⭐ **The predicate is the KERNEL'S, and this is the ratchet that keeps it that way.** Every other
   * roster surface reads `AgentV2.isColleague`; when this one stopped, the tool became the single place
   * a posture or a companion was still offered. A future clause added to the kernel's definition must
   * reach here, and the cheapest proof is that this function stops being a list of its own.
   */
  test("⭐ the catalogue filters by the kernel's own roster predicate", () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "tool", "colleague.ts"),
      "utf8",
    )
    const body = source.slice(
      source.indexOf("export const addressable"),
      source.indexOf("/**", source.indexOf("export const addressable")),
    )
    expect(body).toContain("AgentV2.isColleague(agent)")
    // The hand-rolled clauses that let the ghosts through.
    expect(body).not.toContain('agent.mode !== "subagent"')
    expect(body).not.toContain("!agent.hidden")
  })
})

/**
 * 🔴 **The catalogue is PLAIN: `id - Job`** (owner, 2026-09-27: *"the catalogue should list entries in
 * plain format, like `geryon - Engineer`"*).
 *
 * What it used to print, on the owner's own live instance:
 *
 *     xenia · Xenia · Companion — Xenia, Companion.
 *     geryon · Geryon · Engineer — Geryon, Engineer.
 *
 * Every token after the id was a copy of something already on the line — the name beside the id it
 * restates, the title pushed to the end of a description that restates it too — so the model read past
 * two duplications to reach the one fact, the job. And the duplication was AUTHORED: the seed wrote
 * every officer's description as `` `${name}, ${title}.` ``. Changing the seed does not help an
 * instance that already stored it (the rows are the user's config, and re-seeding is gated on an empty
 * store), which is why the copy is dropped at the READ rather than at the source.
 */
describe("what the roster looks like to a model routing work", () => {
  test("🔴 one line per colleague: the id, and the job", () => {
    const listing = ColleagueTool.formatRoster(
      [{ id: "theron", name: "Theron", title: "Bookkeeper", description: "Owns the ledger" }],
      "nova",
    )
    expect(listing).toBe("theron - Bookkeeper")
  })

  test("🔴 the duplication the owner pasted is gone, from either end", () => {
    // Both halves, because a fix that dropped the name and kept the restatement would still print the
    // title twice, and one that dropped the description and kept the name would still print the id twice.
    const listing = ColleagueTool.formatRoster(
      [{ id: "geryon", name: "Geryon", title: "Engineer", description: "Geryon, Engineer." }],
      "nova",
    )
    expect(listing).toBe("geryon - Engineer")
    expect(listing).not.toContain("Geryon, Engineer.")
    expect(listing.match(/Engineer/g)).toHaveLength(1)
  })

  test("a job title is the only thing after the id — no description column survives", () => {
    // The control for "they just removed the description": a colleague whose description says something
    // a title cannot must NOT leak it back in.
    const listing = ColleagueTool.formatRoster(
      [{ id: "myron", name: "Myron", title: "Artist", description: "Composition, colour, type." }],
      "nova",
    )
    expect(listing).toBe("myron - Artist")
    expect(listing).not.toContain("Composition")
  })

  test("a colleague with NO title degrades to the name, then to the id — never an empty slot", () => {
    // `id · ` reads as a broken list, and a roster with holes is a list nobody routes from.
    expect(ColleagueTool.formatRoster([{ id: "build", name: "Builder" }], "nova")).toBe("build - Builder")
    expect(ColleagueTool.formatRoster([{ id: "build" }], "nova")).toBe("build - build")
    // A title of whitespace is no title, and must not print as one.
    expect(ColleagueTool.formatRoster([{ id: "build", name: "Builder", title: "   " }], "nova")).toBe("build - Builder")
  })

  test("an empty roster says what to do instead of returning nothing", () => {
    // "No colleagues" rendered as an empty string reads as a broken tool, and a model that thinks a
    // tool is broken will try it again.
    expect(ColleagueTool.formatRoster([], "nova")).toContain("no colleagues yet")
  })

  test("🔴 a PAUSED colleague is marked, not hidden", () => {
    // Marked, because asking one spends a hop on a message that never comes back — `permission.ts`
    // answers deny `*` for a paused agent — and the silence only surfaces 30 minutes later as a
    // stall notice.
    // ⚠️ With the description gone, the name is the only handle left between the id and a blank — so
    // the marker has to survive the simplification, or hiding one becomes impossible.
    const listing = ColleagueTool.formatRoster([{ id: "wren", name: "Wren", paused: true }], "nova")
    expect(listing).toBe("wren - Wren · PAUSED (set aside; cannot answer until resumed)")
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
// WILL come here, and forbid waiting for it. A turn that stalls on a peer is the defect principle 13
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

  test("all three delivery outcomes forbid waiting for it", () => {
    expect((source.match(/[Dd]o (?:NOT|not) wait/g) ?? []).length).toBe(3)
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
    // …and that nobody is blocked on it: principle 13 is structural, so the note must not read as a
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
describe("internal colleague delivery is governed by the host org chart", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "tool", "colleague.ts"),
    "utf8",
  )
  const groupStart = source.indexOf('input.op === "ask_group"')
  const oneStart = source.indexOf("const target = input.colleague.trim()", groupStart)
  const branch = source.slice(groupStart, oneStart)

  test("the ledger's own instrument works", () => {
    // A slice that failed to find the branch would make every assertion below vacuous.
    expect(branch.length).toBeGreaterThan(500)
    expect(branch).toContain("deliverGroup")
  })

  test("a local group is not denied by an optional permission rule", () => {
    expect(branch).not.toContain("permission.assert")
  })

  test("a one-to-one message is also not denied before host routing", () => {
    expect(source.slice(oneStart, source.indexOf("handoff.deliver({", oneStart))).not.toContain("permission.assert")
  })

  test("colleagues it could not reach are REPORTED, never swallowed", () => {
    // The sender asked for a room and may have got a smaller one; only it can decide whether that
    // still answers the question.
    expect(branch).toContain("outcome.missing")
  })

  test("the source probe is positioned at the group and one-to-one arms", () => {
    expect(groupStart).toBeGreaterThan(0)
    expect(oneStart).toBeGreaterThan(groupStart)
    expect(branch).toContain("handoff.deliverGroup")
  })
})
