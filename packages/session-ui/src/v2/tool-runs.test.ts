import { expect, test } from "bun:test"
import type { SessionMessage, SessionMessageAssistant, SessionMessageAssistantTool } from "@novaclaw/sdk/v2"
import { groupToolRuns, toolRunSummary } from "./tool-runs"

const tool = (id: string, name = "read") =>
  ({
    id,
    type: "tool",
    name,
    time: { created: 1 },
    state: { status: "completed", input: {}, structured: {}, content: [], outputPaths: [], result: "ok" },
  }) as SessionMessageAssistantTool
const text = (id: string, text: string) => ({ id, type: "text" as const, text })
const message = (id: string, content: SessionMessageAssistant["content"], extra = {}) =>
  ({
    id,
    type: "assistant",
    agent: "iris",
    model: { providerID: "test", id: "test" },
    time: { created: 1, completed: 2 },
    content,
    ...extra,
  }) as SessionMessageAssistant

test("counts each tool in first-use order across adjacent assistant steps", () => {
  const first = message("a1", [tool("r1"), tool("r2"), tool("w1", "write")])
  const second = message("a2", [tool("r3"), tool("w2", "write"), tool("r4"), tool("r5"), tool("w3", "write")])
  const rows = groupToolRuns([first, second])
  expect(rows).toHaveLength(1)
  const run = rows[0]!
  expect(run.kind).toBe("tools")
  if (run.kind !== "tools") throw new Error("Missing tool run")
  expect(toolRunSummary(run.tools)).toBe("Read 5x, Write 3x")
  expect(run.fragments.map((fragment) => fragment.message)).toEqual([first, second])
  expect(run.key).toBe("g:r1")
})

test("prose, user messages and notices interrupt tool runs", () => {
  const prompt = { id: "u1", type: "user", text: "Change direction", time: { created: 3 } } as SessionMessage
  const notice = { id: "n1", type: "synthetic", text: "Context recovered", time: { created: 5 } } as SessionMessage
  const rows = groupToolRuns([
    message("a1", [tool("r1"), tool("r2"), text("p1", "I found it."), tool("w1", "write")]),
    prompt,
    message("a2", [tool("w2", "write"), tool("r3")]),
    notice,
    message("a3", [tool("r4")]),
  ])
  expect(rows.map((row) => row.kind)).toEqual(["tools", "assistant", "tools", "message", "tools", "message", "tools"])
  expect(rows.flatMap((row) => (row.kind === "tools" ? [row.tools.length] : []))).toEqual([2, 1, 2, 1])
})

test("nested reasoning and empty streaming text do not break adjacent tool calls", () => {
  const reasoning = { id: "thinking", type: "reasoning" as const, text: "Inspect another file" }
  const source = message("a1", [tool("r1"), text("empty", " \n"), reasoning, tool("r2")])
  const rows = groupToolRuns([source])
  expect(rows).toHaveLength(1)
  const run = rows[0]!
  if (run.kind !== "tools") throw new Error("Missing tool run")
  expect(run.tools.map((tool) => tool.id)).toEqual(["r1", "r2"])
  expect(run.fragments[0]!.message).toBe(source)
  expect(source.content).toContain(reasoning)
  expect(run.fragments[0]!.content.map((part) => part.id)).toEqual(["r1", "r2"])
})

test("faults remain outside folds and accepted exit ends a run", () => {
  const broken = message("a1", [tool("r1"), tool("r2")], { finish: "broken" })
  const accepted = message("a2", [tool("exit", "exit")], { acceptedExit: { result: "Done", time: 2 } })
  const rows = groupToolRuns([broken, accepted, message("a3", [tool("r3")])])
  expect(rows.map((row) => row.kind)).toEqual(["tools", "assistant", "tools", "tools"])
  const fault = rows[1]!
  if (fault.kind !== "assistant") throw new Error("Missing visible fault")
  expect(fault.fragment.chrome).toBe(true)
  expect(fault.fragment.message).toBe(broken)
})

test("completed work excludes the final answer and keeps prose chrome in one fragment", () => {
  const source = message("a1", [text("before", "Checking"), tool("r1"), tool("w1", "write"), text("answer", "Done")])
  const work = groupToolRuns([source], source.id)
  expect(work.map((row) => row.kind)).toEqual(["assistant", "tools"])
  expect(work.flatMap((row) => (row.kind === "assistant" ? [row.fragment.chrome] : []))).toEqual([false])
  const whole = groupToolRuns([source])
  expect(
    whole.flatMap((row) => (row.kind === "assistant" && row.fragment.chrome ? [row.fragment.content[0]!.id] : [])),
  ).toEqual(["answer"])
})

test("single uses omit the count and unknown tools retain their name", () => {
  expect(toolRunSummary([tool("r1"), tool("w1", "write"), tool("x1", "custom_lookup")])).toBe(
    "Read, Write, Custom lookup",
  )
  expect(toolRunSummary([tool("b1", "bash"), tool("b2", "bash"), tool("r1")])).toBe("Bash 2x, Read")
  expect(groupToolRuns([message("single", [tool("one")])])[0]?.kind).toBe("tools")
})
