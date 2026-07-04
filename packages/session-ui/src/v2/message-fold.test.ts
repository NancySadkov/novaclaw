import { describe, expect, test } from "bun:test"
import type { SessionMessage, V2Event } from "@novaclaw/sdk/v2"
import { activeAssistant, appendMessage, applySessionNextEvent, findAssistant } from "./message-fold"

// The raw event bus delivers `{ type, properties }`; the fold consumes the typed
// `{ type, data }` shape (as the deleted TUI adapter did). These fixtures build the
// latter directly. `data` is checked at runtime by the assertions on fold output.
function ev(type: string, data: Record<string, unknown>): V2Event {
  return { id: `evt_${type}`, type, data } as unknown as V2Event
}

function fold(messages: SessionMessage[], ...events: V2Event[]): SessionMessage[] {
  for (const event of events) applySessionNextEvent(messages, event)
  return messages
}

const MODEL = { providerID: "spark", id: "qwen3.6-35b" }
const prompted = (sessionID: string, messageID: string, text: string, ts = 1) =>
  ev("session.next.prompted", { timestamp: ts, sessionID, messageID, prompt: { text, files: [], agents: [] } })
const stepStarted = (sessionID: string, assistantMessageID: string, ts = 2) =>
  ev("session.next.step.started", { timestamp: ts, sessionID, assistantMessageID, agent: "build", model: MODEL })

describe("appendMessage", () => {
  test("appends oldest-first and dedups by id", () => {
    const messages: SessionMessage[] = []
    const a = { id: "msg_a", type: "system", text: "a", time: { created: 1 } } as SessionMessage
    const b = { id: "msg_b", type: "system", text: "b", time: { created: 2 } } as SessionMessage
    appendMessage(messages, a)
    appendMessage(messages, b)
    appendMessage(messages, a) // duplicate id — ignored
    expect(messages.map((m) => m.id)).toEqual(["msg_a", "msg_b"])
  })
})

describe("applySessionNextEvent", () => {
  test("prompted → user message", () => {
    const messages = fold([], prompted("s", "msg_u", "hello"))
    expect(messages).toHaveLength(1)
    const user = messages[0]!
    expect(user.type).toBe("user")
    if (user.type === "user") {
      expect(user.text).toBe("hello")
      expect(user.time.created).toBe(1)
    }
  })

  test("builds an assistant turn: step → text stream → tool → step.ended", () => {
    const messages = fold(
      [],
      stepStarted("s", "msg_a", 2),
      ev("session.next.text.started", { timestamp: 3, sessionID: "s", assistantMessageID: "msg_a", textID: "t1" }),
      ev("session.next.text.delta", {
        timestamp: 4,
        sessionID: "s",
        assistantMessageID: "msg_a",
        textID: "t1",
        delta: "Hel",
      }),
      ev("session.next.text.delta", {
        timestamp: 5,
        sessionID: "s",
        assistantMessageID: "msg_a",
        textID: "t1",
        delta: "lo",
      }),
      ev("session.next.text.ended", {
        timestamp: 6,
        sessionID: "s",
        assistantMessageID: "msg_a",
        textID: "t1",
        text: "Hello",
      }),
      ev("session.next.tool.input.started", {
        timestamp: 7,
        sessionID: "s",
        assistantMessageID: "msg_a",
        callID: "c1",
        name: "read",
      }),
      ev("session.next.tool.input.delta", {
        timestamp: 8,
        sessionID: "s",
        assistantMessageID: "msg_a",
        callID: "c1",
        delta: '{"path":1}',
      }),
      ev("session.next.tool.called", {
        timestamp: 9,
        sessionID: "s",
        assistantMessageID: "msg_a",
        callID: "c1",
        tool: "read",
        input: { path: 1 },
        provider: { executed: true },
      }),
      ev("session.next.tool.success", {
        timestamp: 10,
        sessionID: "s",
        assistantMessageID: "msg_a",
        callID: "c1",
        structured: { ok: true },
        content: [],
        provider: { executed: true },
      }),
      ev("session.next.step.ended", {
        timestamp: 11,
        sessionID: "s",
        assistantMessageID: "msg_a",
        finish: "stop",
        cost: 0.01,
        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    )

    const assistant = findAssistant(messages, "msg_a")!
    expect(assistant).toBeDefined()
    expect(assistant.time.completed).toBe(11)
    expect(assistant.finish).toBe("stop")
    expect(assistant.tokens?.output).toBe(20)
    expect(assistant.content).toHaveLength(2)

    const text = assistant.content[0]!
    expect(text.type).toBe("text")
    if (text.type === "text") expect(text.text).toBe("Hello")

    const tool = assistant.content[1]!
    expect(tool.type).toBe("tool")
    if (tool.type === "tool") {
      expect(tool.state.status).toBe("completed")
      if (tool.state.status === "completed") {
        expect(tool.state.structured).toEqual({ ok: true })
        expect(tool.state.outputPaths).toEqual([]) // defaulted when the event omits it (matches core updater)
      }
    }
    // A settled assistant is no longer the active one.
    expect(activeAssistant(messages)).toBeUndefined()
  })

  test("orders oldest-first and completes the prior assistant on a new step", () => {
    const messages = fold([], prompted("s", "msg_u", "hi", 1), stepStarted("s", "msg_a1", 2), stepStarted("s", "msg_a2", 5))
    expect(messages.map((m) => m.id)).toEqual(["msg_u", "msg_a1", "msg_a2"])
    expect(findAssistant(messages, "msg_a1")!.time.completed).toBe(5) // superseded → completed
    expect(findAssistant(messages, "msg_a2")!.time.completed).toBeUndefined() // still active
    expect(activeAssistant(messages)!.id).toBe("msg_a2")
  })

  test("is idempotent on repeated prompted / step ids (mid-turn reload safe)", () => {
    const messages = fold(
      [],
      prompted("s", "msg_u", "hi"),
      prompted("s", "msg_u", "hi"),
      stepStarted("s", "msg_a"),
      stepStarted("s", "msg_a"),
    )
    expect(messages.map((m) => m.id)).toEqual(["msg_u", "msg_a"])
    // The replayed step.started must NOT have re-completed the active assistant.
    expect(activeAssistant(messages)!.id).toBe("msg_a")
  })

  test("shell start → ended records output and completion", () => {
    const messages = fold(
      [],
      ev("session.next.shell.started", {
        timestamp: 1,
        sessionID: "s",
        messageID: "msg_sh",
        callID: "c1",
        command: "ls",
      }),
      ev("session.next.shell.ended", { timestamp: 2, sessionID: "s", callID: "c1", output: "file.txt" }),
    )
    const shell = messages[0]!
    expect(shell.type).toBe("shell")
    if (shell.type === "shell") {
      expect(shell.output).toBe("file.txt")
      expect(shell.time.completed).toBe(2)
    }
  })

  test("reasoning start → delta → ended accumulates then finalizes text", () => {
    const messages = fold(
      [],
      stepStarted("s", "msg_a"),
      ev("session.next.reasoning.started", { timestamp: 3, sessionID: "s", assistantMessageID: "msg_a", reasoningID: "r1" }),
      ev("session.next.reasoning.delta", {
        timestamp: 4,
        sessionID: "s",
        assistantMessageID: "msg_a",
        reasoningID: "r1",
        delta: "th",
      }),
      ev("session.next.reasoning.delta", {
        timestamp: 5,
        sessionID: "s",
        assistantMessageID: "msg_a",
        reasoningID: "r1",
        delta: "ink",
      }),
      ev("session.next.reasoning.ended", {
        timestamp: 6,
        sessionID: "s",
        assistantMessageID: "msg_a",
        reasoningID: "r1",
        text: "think",
      }),
    )
    const reasoning = findAssistant(messages, "msg_a")!.content[0]!
    expect(reasoning.type).toBe("reasoning")
    if (reasoning.type === "reasoning") {
      expect(reasoning.text).toBe("think")
      expect(reasoning.time?.completed).toBe(6)
    }
  })

  test("tool.failed transitions a running tool to error", () => {
    const messages = fold(
      [],
      stepStarted("s", "msg_a"),
      ev("session.next.tool.input.started", {
        timestamp: 3,
        sessionID: "s",
        assistantMessageID: "msg_a",
        callID: "c1",
        name: "bash",
      }),
      ev("session.next.tool.called", {
        timestamp: 4,
        sessionID: "s",
        assistantMessageID: "msg_a",
        callID: "c1",
        tool: "bash",
        input: {},
        provider: { executed: true },
      }),
      ev("session.next.tool.failed", {
        timestamp: 5,
        sessionID: "s",
        assistantMessageID: "msg_a",
        callID: "c1",
        error: { type: "unknown", message: "boom" },
        provider: { executed: true },
      }),
    )
    const tool = findAssistant(messages, "msg_a")!.content[0]!
    expect(tool.type).toBe("tool")
    if (tool.type === "tool") {
      expect(tool.state.status).toBe("error")
      if (tool.state.status === "error") expect(tool.state.error.message).toBe("boom")
    }
  })

  test("compaction.ended appends a compaction message", () => {
    const messages = fold(
      [],
      ev("session.next.compaction.ended", {
        timestamp: 1,
        sessionID: "s",
        messageID: "msg_c",
        reason: "manual",
        text: "the summary",
        recent: "recent tail",
      }),
    )
    const compaction = messages[0]!
    expect(compaction.type).toBe("compaction")
    if (compaction.type === "compaction") {
      expect(compaction.summary).toBe("the summary")
      expect(compaction.recent).toBe("recent tail")
    }
  })

  test("ignores non-transcript session.next events and unrelated events", () => {
    const messages = fold(
      [],
      ev("session.next.moved", { timestamp: 1, sessionID: "s", location: { directory: "/x" } }),
      ev("session.next.prompt.admitted", { timestamp: 1, sessionID: "s", messageID: "msg_u", prompt: { text: "x" }, delivery: "queue" }),
      ev("session.status", { sessionID: "s", status: { type: "idle" } }),
    )
    expect(messages).toHaveLength(0)
  })
})
