import { describe, expect, test } from "bun:test"
import { answerStart, groupTurns, type AnswerPart } from "./turn-group"

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
