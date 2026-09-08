import { expect, test } from "bun:test"
import { MAX_LABEL, SYSTEM, clean } from "./label"

test("takes the first usable line and drops a model's thinking", () => {
  expect(clean("<think>weighing it up</think>\nreviewing the P2P handshake")).toBe("reviewing the P2P handshake")
  expect(clean("\n\n  fixing flaky calendar tests  \n")).toBe("fixing flaky calendar tests")
})

test("🔴 code-shaped output never becomes a status line", () => {
  // The titler learned this the hard way: a model echoing its seed produced the live title
  // `define_tool({"name": …`. A contacts row is prose or it is nothing.
  expect(clean('{"task": "reviewing"}')).toBeUndefined()
  expect(clean("<tool_call>read</tool_call>")).toBeUndefined()
  expect(clean('define_tool({"name": "greet"})')).toBeUndefined()
  // ...but a later line that IS prose is still usable.
  expect(clean('{"junk": 1}\nreviewing the handshake')).toBe("reviewing the handshake")
})

test("strips the wrappers a model reaches for when asked for one line", () => {
  expect(clean('"reviewing the P2P handshake."')).toBe("reviewing the P2P handshake")
  expect(clean("- fixing flaky calendar tests")).toBe("fixing flaky calendar tests")
  expect(clean("`waiting on the user`")).toBe("waiting on the user")
})

test("🔴 nothing usable returns undefined, never a placeholder", () => {
  /**
   * The pass leaves the PREVIOUS line in place and tries again next interval. A colleague showing
   * slightly stale work is honest; one showing "Unknown" or a blank row has been given words it
   * never said — which is what "New session" was, in the surface this replaces.
   */
  expect(clean("")).toBeUndefined()
  expect(clean("<think>only thinking</think>")).toBeUndefined()
  expect(clean('"""')).toBeUndefined()
})

test("a long line is truncated to fit one contacts row", () => {
  const long = clean("a".repeat(200))!
  expect(long.length).toBeLessThanOrEqual(MAX_LABEL)
  expect(long.endsWith("…")).toBe(true)
  // The boundary in the direction that would silently clip a legitimate line.
  expect(clean("b".repeat(MAX_LABEL))).toBe("b".repeat(MAX_LABEL))
})

test("the prompt asks for a task, and says what it must not name", () => {
  // Pinned because these are the two ways the output stops being usable in a contacts row: it
  // becomes a summary of the conversation, or it names machinery the user never sees.
  expect(SYSTEM).toContain("CURRENT task")
  expect(SYSTEM).toContain("never name tools")
  expect(SYSTEM).toContain(String(MAX_LABEL))
})
