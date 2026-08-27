import { describe, expect, test } from "bun:test"
import { answerStart, groupTurns, stableGroups, type AnswerPart, foldClosing } from "./turn-group"

interface Msg {
  readonly type: string
  readonly id: string
  readonly steer?: boolean
}

const user = (id: string): Msg => ({ type: "user", id })
const steer = (id: string): Msg => ({ type: "user", id, steer: true })
const assistant = (id: string): Msg => ({ type: "assistant", id })
const isTurnStart = (m: Msg) => m.type === "user" && !m.steer
const ids = (messages: readonly Msg[]) => messages.map((m) => m.id)

describe("groupTurns", () => {
  test("one prompt and its response is one turn", () => {
    const groups = groupTurns([user("u1"), assistant("a1"), assistant("a2")], isTurnStart)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.lead!.id).toBe("u1")
    expect(ids(groups[0]!.body)).toEqual(["a1", "a2"])
  })

  test("a second prompt opens a second turn", () => {
    const groups = groupTurns([user("u1"), assistant("a1"), user("u2"), assistant("a2")], isTurnStart)
    expect(groups.map((g) => g.lead!.id)).toEqual(["u1", "u2"])
    expect(ids(groups[1]!.body)).toEqual(["a2"])
  })

  test("a harness steer stays INSIDE the turn it nudged", () => {
    // The regression this module exists to prevent: a steer rides the user role, so a naive
    // type-based split would cut this into two turns and strand the answer in the second.
    const groups = groupTurns([user("u1"), assistant("a1"), steer("s1"), assistant("a2")], isTurnStart)
    expect(groups).toHaveLength(1)
    expect(ids(groups[0]!.body)).toEqual(["a1", "s1", "a2"])
  })

  test("agent-initiated messages before any prompt form a leadless group", () => {
    const groups = groupTurns([assistant("a0"), user("u1"), assistant("a1")], isTurnStart)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.lead).toBeUndefined()
    expect(ids(groups[0]!.body)).toEqual(["a0"])
    expect(groups[1]!.lead!.id).toBe("u1")
  })

  test("a prompt with no response yet is still a turn", () => {
    const groups = groupTurns([user("u1")], isTurnStart)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.body).toEqual([])
  })

  test("two prompts in a row are two turns, not one", () => {
    const groups = groupTurns([user("u1"), user("u2")], isTurnStart)
    expect(groups.map((g) => g.lead!.id)).toEqual(["u1", "u2"])
  })

  test("an empty transcript has no turns", () => {
    expect(groupTurns([], isTurnStart)).toEqual([])
  })
})

describe("answerStart", () => {
  const text = (value: string): AnswerPart => ({ type: "text", text: value })
  const tool: AnswerPart = { type: "tool" }
  const reasoning: AnswerPart = { type: "reasoning", text: "hmm" }

  test("trailing prose after tool work is the answer", () => {
    expect(answerStart([reasoning, tool, text("done, all green")])).toBe(2)
  })

  test("the run extends across several trailing text parts", () => {
    expect(answerStart([tool, text("first"), text("second")])).toBe(1)
  })

  test("narration BEFORE a tool call is work, not answer", () => {
    expect(answerStart([text("let me check"), tool, text("it passes")])).toBe(2)
  })

  test("a message ending on a tool call has no answer", () => {
    const content = [text("running the suite"), tool]
    expect(answerStart(content)).toBe(content.length)
  })

  test("a message ending on reasoning has no answer", () => {
    const content = [text("hi"), reasoning]
    expect(answerStart(content)).toBe(content.length)
  })

  test("a trailing empty delta does not fold the answer away", () => {
    expect(answerStart([tool, text("the result"), text("")])).toBe(1)
  })

  test("prose only — the whole message is the answer", () => {
    expect(answerStart([text("just talking")])).toBe(0)
  })

  test("empty content has no answer", () => {
    expect(answerStart([])).toBe(0)
  })
})

describe("stableGroups — why the chat jumped to the top after a tool result", () => {
  const msg = (id: string) => ({ id })
  const group = (lead: unknown, body: unknown[]) => ({ lead, body }) as never

  // The regression itself: recomputing produces equal-but-new objects, and `<For>` keys by
  // reference — so without this every turn is destroyed and rebuilt, the transcript's height
  // collapses, and the browser clamps scrollTop to the top.
  test("returns the SAME array when nothing changed, so <For> re-renders nothing", () => {
    const a = msg("u1")
    const b = msg("a1")
    const previous = [group(a, [b])]
    const recomputed = [group(a, [b])]
    expect(stableGroups(previous, recomputed)).toBe(previous)
  })

  test("keeps the identity of untouched turns while a new one is added", () => {
    const lead = msg("u1")
    const body = msg("a1")
    const first = group(lead, [body])
    const second = group(msg("u2"), [msg("a2")])
    // A recompute rebuilds the first turn as an EQUAL but distinct object; only the second is new.
    const out = stableGroups([first], [group(lead, [body]), second])
    expect(out[0]).toBe(first)
    expect(out[1]).toBe(second)
  })

  test("a turn whose body GREW gets a new identity, so it re-renders", () => {
    const lead = msg("u1")
    const one = msg("a1")
    const previous = [group(lead, [one])]
    const out = stableGroups(previous, [group(lead, [one, msg("a2")])])
    expect(out[0]).not.toBe(previous[0])
  })

  // ⚠️ Comparing ids would be wrong here: a reconcile can REPLACE a row with a fresh object
  // carrying the same id, and reusing the old group would freeze that turn's render.
  test("a REPLACED message object breaks identity even though its id is unchanged", () => {
    const lead = msg("u1")
    const previous = [group(lead, [msg("a1")])]
    const out = stableGroups(previous, [group(lead, [msg("a1")])])
    expect(out[0]).not.toBe(previous[0])
  })
})


// 🔴 The shape that crashed shipped 0.1.67 and took the WHOLE app down: a SETTLED turn whose last
// row is not an assistant message, so there is no closing message for the fold to render — while
// every other clause of the gate is satisfied. `native-transcript.tsx` used to paper over it with
// `closing()!`, and `AssistantMessage` then read `props.message.time` on `undefined`.
describe("foldClosing — a fold never renders without the message it is made of", () => {
  const settledTurnEndingInATool = {
    closing: undefined,
    running: false,
    hasWork: true,
    // No closing message means no answer, so `outcome` supplies its stand-in — which is exactly
    // what satisfied the old gate's third clause and let the branch be entered.
    hasAnswer: false,
    outcome: "Ran 3 steps",
  }

  test("refuses to fold when the turn has no closing assistant message", () => {
    expect(foldClosing(settledTurnEndingInATool)).toBeUndefined()
  })

  test("the missing message OUTRANKS every other clause", () => {
    expect(foldClosing({ ...settledTurnEndingInATool, hasAnswer: true })).toBeUndefined()
    expect(foldClosing({ ...settledTurnEndingInATool, hasWork: true, outcome: "x" })).toBeUndefined()
  })

  test("still folds a settled turn that HAS a closing message", () => {
    const closing = { id: "msg_a" }
    expect(foldClosing({ ...settledTurnEndingInATool, closing })).toBe(closing)
  })

  test("a running turn never folds, message or not", () => {
    expect(foldClosing({ ...settledTurnEndingInATool, closing: { id: "msg_a" }, running: true })).toBeUndefined()
  })

  test("a turn with nothing behind the answer never folds", () => {
    expect(foldClosing({ ...settledTurnEndingInATool, closing: { id: "msg_a" }, hasWork: false })).toBeUndefined()
  })
})
