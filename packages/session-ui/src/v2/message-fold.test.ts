import { describe, expect, test } from "bun:test"
import type { SessionMessage, V2Event } from "@novaclaw/sdk/v2"
import {
  unqueuedPending,
  activeAssistant,
  appendMessage,
  applySessionNextEvent,
  findAssistant,
  isInFlightAssistant,
  mergeNativeMessages,
} from "./message-fold"

test("a running tool remains in-flight even if its assistant timestamp was already completed", () => {
  const message = assistantMsg("msg_tool", 1, { completed: 2 }) as Extract<SessionMessage, { type: "assistant" }>
  message.content.push({
    type: "tool",
    id: "call_1",
    name: "bash",
    time: { created: 1, ran: 2 },
    state: { status: "running", input: { command: "bun test" }, structured: {}, content: [] },
  } as never)
  expect(isInFlightAssistant(message)).toBe(true)
})

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

const userMsg = (id: string, created: number, text = "hi") =>
  ({ id, type: "user", text, time: { created } }) as SessionMessage
const assistantMsg = (id: string, created: number, opts?: { completed?: number; text?: string }) =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: MODEL,
    content: opts?.text !== undefined ? [{ type: "text", id: `${id}-t`, text: opts.text }] : [],
    time: { created, completed: opts?.completed },
  }) as SessionMessage
const reverted = (sessionID: string, messageID: string) =>
  ev("session.next.revert.committed", { timestamp: 9, sessionID, messageID })

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
  test("revert.committed prunes messages after the boundary, keeping the boundary itself", () => {
    const messages = [userMsg("msg_1", 1), assistantMsg("msg_2", 2), userMsg("msg_3", 3), assistantMsg("msg_4", 4)]
    fold(messages, reverted("s", "msg_2"))
    expect(messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
  })

  test("revert.committed with the before-everything sentinel (msg_) clears the whole transcript", () => {
    // Reverting the FIRST prompt has no predecessor boundary → the sentinel `msg_` sorts before every
    // real id, so every message is "after" it and the transcript empties (owner-hit: the first prompt
    // used to linger because the fallback kept it as its own boundary).
    const messages = [userMsg("msg_1", 1), assistantMsg("msg_2", 2)]
    fold(messages, reverted("s", "msg_"))
    expect(messages).toHaveLength(0)
  })

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

  test("synthetic Device refusal preserves its structured one-click repair", () => {
    const messages = fold(
      [],
      ev("session.next.synthetic", {
        timestamp: 2,
        sessionID: "ses_test",
        messageID: "msg_device",
        text: "Device pin is incompatible.",
        repair: { type: "unpin-device", device: "spark" },
      }),
    )
    expect(messages[0]).toMatchObject({
      type: "synthetic",
      sessionID: "ses_test",
      repair: { type: "unpin-device", device: "spark" },
    })
  })

  test("permission.changed → first-class permission card message", () => {
    const messages = fold(
      [],
      ev("session.next.permission.changed", {
        timestamp: 3,
        sessionID: "s",
        messageID: "msg_permission",
        op: "lower",
        previous: "bypass",
        mode: "plan",
        ceiling: "bypass",
        justification: "reading the codebase first; changing nothing yet",
      }),
    )
    expect(messages).toEqual([
      {
        id: "msg_permission",
        type: "permission-changed",
        op: "lower",
        previous: "bypass",
        mode: "plan",
        ceiling: "bypass",
        justification: "reading the codebase first; changing nothing yet",
        time: { created: 3 },
      },
    ])
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
      ev("session.next.tool.labelled", {
        timestamp: 9,
        sessionID: "s",
        assistantMessageID: "msg_a",
        callID: "c1",
        title: "Inspect the requested file",
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
      expect(tool.title).toBe("Inspect the requested file")
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
    const messages = fold(
      [],
      prompted("s", "msg_u", "hi", 1),
      stepStarted("s", "msg_a1", 2),
      stepStarted("s", "msg_a2", 5),
    )
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
      ev("session.next.reasoning.started", {
        timestamp: 3,
        sessionID: "s",
        assistantMessageID: "msg_a",
        reasoningID: "r1",
      }),
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

  test("durable stream checkpoints converge after reconnect without duplicating live deltas", () => {
    const messages = fold(
      [],
      stepStarted("s", "msg_a"),
      ev("session.next.text.started", {
        timestamp: 3,
        sessionID: "s",
        assistantMessageID: "msg_a",
        textID: "t1",
      }),
      ev("session.next.text.delta", {
        timestamp: 4,
        sessionID: "s",
        assistantMessageID: "msg_a",
        textID: "t1",
        delta: "hello",
      }),
      ev("session.next.text.progress", {
        timestamp: 5,
        sessionID: "s",
        assistantMessageID: "msg_a",
        textID: "t1",
        offset: 0,
        delta: "hello",
      }),
      ev("session.next.text.progress", {
        timestamp: 6,
        sessionID: "s",
        assistantMessageID: "msg_a",
        textID: "t1",
        offset: 5,
        delta: " world",
      }),
    )
    const text = findAssistant(messages, "msg_a")!.content[0]!
    expect(text.type).toBe("text")
    if (text.type === "text") expect(text.text).toBe("hello world")

    const reconnect = fold(
      [],
      stepStarted("s", "msg_b"),
      ev("session.next.tool.input.started", {
        timestamp: 7,
        sessionID: "s",
        assistantMessageID: "msg_b",
        callID: "c1",
        name: "read",
      }),
      ev("session.next.tool.input.progress", {
        timestamp: 8,
        sessionID: "s",
        assistantMessageID: "msg_b",
        callID: "c1",
        offset: 0,
        delta: '{"path":"a"}',
      }),
      ev("session.next.reasoning.started", {
        timestamp: 9,
        sessionID: "s",
        assistantMessageID: "msg_b",
        reasoningID: "r1",
      }),
      ev("session.next.reasoning.progress", {
        timestamp: 10,
        sessionID: "s",
        assistantMessageID: "msg_b",
        reasoningID: "r1",
        offset: 0,
        delta: "checking",
      }),
    )
    const assistant = findAssistant(reconnect, "msg_b")!
    const tool = assistant.content[0]!
    const reasoning = assistant.content[1]!
    expect(tool.type).toBe("tool")
    if (tool.type === "tool" && tool.state.status === "pending") expect(tool.state.input).toBe('{"path":"a"}')
    expect(reasoning.type).toBe("reasoning")
    if (reasoning.type === "reasoning") expect(reasoning.text).toBe("checking")
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

  test("compaction stays visible from start through durable progress and completion", () => {
    const messages = fold(
      [],
      ev("session.next.compaction.started", {
        timestamp: 1,
        sessionID: "s",
        messageID: "msg_c",
        reason: "manual",
      }),
      ev("session.next.compaction.delta", {
        timestamp: 2,
        sessionID: "s",
        messageID: "msg_c",
        text: "1234",
      }),
      ev("session.next.compaction.progress", {
        timestamp: 3,
        sessionID: "s",
        messageID: "msg_c",
        generatedChars: 12,
      }),
      ev("session.next.compaction.ended", {
        timestamp: 11,
        sessionID: "s",
        messageID: "msg_c",
        reason: "manual",
        text: "the summary",
        recent: "recent tail",
        prefixSeq: 0,
        prefixHash: "hash",
        generatedChars: 20,
      }),
    )
    expect(messages).toHaveLength(1)
    const compaction = messages[0]!
    expect(compaction.type).toBe("compaction")
    if (compaction.type === "compaction") {
      expect(compaction.generatedChars).toBe(20)
      expect(compaction.time).toEqual({ created: 1, completed: 11 })
      expect(compaction.summary).toBe("the summary")
      expect(compaction.recent).toBe("recent tail")
    }
  })

  test("ignores non-transcript session.next events and unrelated events", () => {
    const messages = fold(
      [],
      ev("session.next.moved", { timestamp: 1, sessionID: "s", location: { directory: "/x" } }),
      ev("session.next.prompt.admitted", {
        timestamp: 1,
        sessionID: "s",
        messageID: "msg_u",
        prompt: { text: "x" },
        delivery: "queue",
      }),
      ev("session.status", { sessionID: "s", status: { type: "idle" } }),
    )
    expect(messages).toHaveLength(0)
  })
})

describe("mergeNativeMessages", () => {
  test("bootstrap: sorts a fetched page oldest-first", () => {
    const result = mergeNativeMessages([], [userMsg("msg_2", 2), userMsg("msg_1", 1)])
    expect(result.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
  })

  test("orders by the durable sequence, NOT by acceptance time", () => {
    // The measured defect (2026-08-11), with the real numbers from the audit session: a prompt
    // queued behind a running turn is accepted five seconds BEFORE the answer it waits behind, so
    // sorting on `time.created` renders the earlier prompt as unanswered and files its answer under
    // the queued one.
    const answer = { ...assistantMsg("msg_b", 1786429040726, { completed: 1786429041000 }), seq: 26 } as SessionMessage
    const queued = { ...userMsg("msg_c", 1786429035227, "Also mention the TLB."), seq: 47 } as SessionMessage
    const prompt = { ...userMsg("msg_a", 1786429033197, "600-word explanation"), seq: 24 } as SessionMessage

    const merged = mergeNativeMessages([], [queued, answer, prompt])
    expect(merged.map((m) => m.id)).toEqual(["msg_a", "msg_b", "msg_c"])
  })

  test("a spawned session's stale prompt timestamp does not drag it to the top", () => {
    // The second shape found in the same sweep: a sub-agent's task prompt carried a `created` from
    // days earlier and sorted ahead of 22 messages that genuinely preceded nothing.
    const old = { ...userMsg("msg_task", 1784587644222, "Do the subtask"), seq: 26 } as SessionMessage
    const notice = {
      ...assistantMsg("msg_earlier", 1786070022492, { completed: 1786070022500 }),
      seq: 23,
    } as SessionMessage
    expect(mergeNativeMessages([], [old, notice]).map((m) => m.id)).toEqual(["msg_earlier", "msg_task"])
  })

  test("an UNSEQUENCED message sorts last — it has not been through the aggregate, so it is newest", () => {
    const settled = { ...assistantMsg("msg_1", 1000, { completed: 1100 }), seq: 5 } as SessionMessage
    const inFlight = assistantMsg("msg_2", 900) // streaming; no seq, and an older created
    expect(mergeNativeMessages([inFlight], [settled]).map((m) => m.id)).toEqual(["msg_1", "msg_2"])
  })

  test("falls back to created then id when nothing carries a sequence", () => {
    const result = mergeNativeMessages([], [userMsg("msg_b", 2), userMsg("msg_a", 1)])
    expect(result.map((m) => m.id)).toEqual(["msg_a", "msg_b"])
  })

  test("loadMore: unions an older page ahead of the current tail", () => {
    const current = [assistantMsg("msg_9", 9, { completed: 9 })]
    const older = [userMsg("msg_1", 1), assistantMsg("msg_2", 2, { completed: 2 })]
    expect(mergeNativeMessages(current, older).map((m) => m.id)).toEqual(["msg_1", "msg_2", "msg_9"])
  })

  // A client that MISSES `revert.committed` (SSE reconnect, backgrounded tab, revert done on another
  // device) used to keep the deleted messages forever, because the merge was a pure union: absent from the
  // server simply meant "keep ours". A no-cursor fetch is a full reconcile and must be able to drop them.
  test("authoritative reconcile drops rows the server deleted inside the fetched range", () => {
    const current = [userMsg("msg_1", 1), assistantMsg("msg_2", 2, { completed: 2 }), userMsg("msg_3", 3)]
    const fetched = [userMsg("msg_1", 1)] // msg_2/msg_3 were reverted away server-side
    const merged = mergeNativeMessages(current, fetched, { authoritative: true, asOf: 100 })
    expect(merged.map((m) => m.id)).toEqual(["msg_1"])
  })

  test("a fully reverted session clears on an authoritative empty fetch", () => {
    const current = [userMsg("msg_1", 1), assistantMsg("msg_2", 2, { completed: 2 })]
    expect(mergeNativeMessages(current, [], { authoritative: true, asOf: 100 })).toEqual([])
  })

  test("authority is bounded by the fetched range — an older page is NOT dropped", () => {
    // The newest-page fetch says nothing about msg_1, which sits below its range.
    const current = [userMsg("msg_1", 1), assistantMsg("msg_8", 8, { completed: 8 })]
    const fetched = [assistantMsg("msg_8", 8, { completed: 8 }), userMsg("msg_9", 9)]
    const merged = mergeNativeMessages(current, fetched, { authoritative: true, asOf: 100 })
    expect(merged.map((m) => m.id)).toEqual(["msg_1", "msg_8", "msg_9"])
  })

  test("a row that arrived AFTER the fetch started survives the reconcile", () => {
    const current = [userMsg("msg_1", 1), userMsg("msg_5", 50)] // created AFTER the fetch was issued
    const fetched = [userMsg("msg_1", 1)]
    const merged = mergeNativeMessages(current, fetched, { authoritative: true, asOf: 10 })
    expect(merged.map((m) => m.id)).toEqual(["msg_1", "msg_5"])
  })

  test("an in-flight assistant is never dropped by a reconcile", () => {
    const current = [userMsg("msg_1", 1), assistantMsg("msg_2", 2, { text: "streaming" })] // no completed
    const merged = mergeNativeMessages(current, [userMsg("msg_1", 1)], { authoritative: true, asOf: 100 })
    expect(merged.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
  })

  test("a PAGED load stays a union — it may not drop anything", () => {
    const current = [userMsg("msg_1", 1), userMsg("msg_2", 2)]
    const merged = mergeNativeMessages(current, [userMsg("msg_1", 1)])
    expect(merged.map((m) => m.id)).toEqual(["msg_1", "msg_2"])
  })

  test("settled conflict: the fetched copy wins", () => {
    const current = [assistantMsg("msg_a", 1, { completed: 1, text: "stale" })]
    const fetched = [assistantMsg("msg_a", 1, { completed: 1, text: "fresh" })]
    const merged = mergeNativeMessages(current, fetched)
    expect(merged).toHaveLength(1)
    const a = merged[0]!
    if (a.type === "assistant" && a.content[0]?.type === "text") expect(a.content[0].text).toBe("fresh")
  })

  test("an equal reconcile preserves message identity instead of rebuilding the transcript", () => {
    const current = [
      userMsg("msg_1", 1, "same prompt"),
      assistantMsg("msg_2", 2, { completed: 3, text: "same answer" }),
    ]
    const fetched = structuredClone(current)
    const merged = mergeNativeMessages(current, fetched, { authoritative: true, asOf: 100 })

    expect(merged).not.toBe(current)
    expect(merged[0]).toBe(current[0])
    expect(merged[1]).toBe(current[1])
  })

  test("in-flight assistant: the current copy wins (live deltas preserved over a lagging fetch)", () => {
    const current = [assistantMsg("msg_a", 1, { text: "Hello (live)" })] // no completed → in-flight
    const fetched = [assistantMsg("msg_a", 1, { text: "" })] // persisted copy lags, still in-flight
    const merged = mergeNativeMessages(current, fetched)
    const a = merged[0]!
    if (a.type === "assistant" && a.content[0]?.type === "text") expect(a.content[0].text).toBe("Hello (live)")
  })

  test("a completed current assistant wins over an incomplete fetched snapshot", () => {
    const current = [assistantMsg("msg_a", 1, { completed: 2, text: "final" })]
    const fetched = [assistantMsg("msg_a", 1, { text: "partial" })]
    const merged = mergeNativeMessages(current, fetched)
    const a = merged[0]!
    if (a.type === "assistant" && a.content[0]?.type === "text") expect(a.content[0].text).toBe("final")
    if (a.type === "assistant") expect(a.time.completed).toBe(2)
  })

  test("current-only in-flight tail is preserved when the fetch page omits it", () => {
    const current = [userMsg("msg_1", 1), assistantMsg("msg_2", 2)] // assistant streaming, not yet persisted
    const fetched = [userMsg("msg_1", 1)] // snapshot predates the assistant
    expect(mergeNativeMessages(current, fetched).map((m) => m.id)).toEqual(["msg_1", "msg_2"])
  })

  test("stale in-flight assistant: a COMPLETED fetched copy wins (heals missed step/reasoning.ended)", () => {
    // The stream dropped events mid-turn, so the live copy never saw the turn end — the
    // server-persisted completed copy is the truth, not a lagging snapshot. Keeping the
    // live copy here would pin a forever-"streaming" message no reconcile could heal.
    const current = [assistantMsg("msg_a", 1, { text: "partial (live)" })] // no completed → looks in-flight
    const fetched = [assistantMsg("msg_a", 1, { completed: 5, text: "full (persisted)" })]
    const merged = mergeNativeMessages(current, fetched)
    expect(merged).toHaveLength(1)
    const a = merged[0]!
    expect(a.type === "assistant" && a.time.completed).toBe(5)
    if (a.type === "assistant" && a.content[0]?.type === "text") expect(a.content[0].text).toBe("full (persisted)")
  })
})

describe("unqueuedPending — the duplicate the owner saw on a packaged build", () => {
  // The exact report: the first "hi" of a session shown as BOTH the accepted message and a Queued
  // bubble, the queued copy vanishing a moment later.
  test("drops a queued row whose message is already in the transcript", () => {
    const pending = [{ id: "msg_hi", text: "hi" }]
    expect(unqueuedPending(pending, [{ id: "msg_hi" }])).toEqual([])
  })

  test("keeps a queued row the transcript does not have yet", () => {
    const pending = [{ id: "msg_second", text: "and this" }]
    expect(unqueuedPending(pending, [{ id: "msg_hi" }])).toEqual(pending)
  })

  test("filters per row, not all-or-nothing", () => {
    const shown = { id: "a", text: "shown" }
    const hidden = { id: "b", text: "not yet" }
    expect(unqueuedPending([shown, hidden], [{ id: "a" }])).toEqual([hidden])
  })

  test("an absent or empty list is empty, never undefined", () => {
    expect(unqueuedPending(undefined, [])).toEqual([])
    expect(unqueuedPending([], [{ id: "a" }])).toEqual([])
  })
})

// 🔴 The renderer-fatal shape, from the shipped 0.1.67 crash: an assistant row WITHOUT its `time`
// struct. The schema declares `time` required, so nothing here is defending against a legal value —
// it is defending against a row that reached the store anyway and took the whole UI down with
// `TypeError: Cannot read properties of undefined (reading 'time')`.
//
// ⚠️ Owner, 2026-08-27: *"assistant failing to read something is not a fatal error, but a normal
// event"*. So the bar is not "does not throw" — it is that the fold gives the HONEST answer and
// keeps going: a message with no completion stamp has not completed.
describe("a malformed assistant row is an event, not a crash", () => {
  const timeless = () => [{ id: "msg_a", type: "assistant", content: [] } as unknown as SessionMessage]

  test("activeAssistant treats a row with no `time` as still in flight", () => {
    const messages = timeless()
    expect(() => activeAssistant(messages)).not.toThrow()
    expect(activeAssistant(messages)?.id).toBe("msg_a")
  })

  test("a step that ends REPAIRS the missing time struct instead of throwing", () => {
    const messages = timeless()
    expect(() =>
      fold(messages, ev("session.next.step.ended", { assistantMessageID: "msg_a", timestamp: 4242 })),
    ).not.toThrow()
    // Repaired, not skipped: a stamp that silently did nothing would leave the transcript showing a
    // turn that spins forever, which is the same defect wearing a calmer face.
    const assistant = findAssistant(messages, "msg_a")!
    expect(assistant.time.completed).toBe(4242)
    expect(activeAssistant(messages)).toBeUndefined()
  })

  test("ordering survives a row with no `time`", () => {
    const messages = [
      { id: "msg_b", type: "assistant", content: [], time: { created: 2 } },
      { id: "msg_a", type: "assistant", content: [] },
    ] as unknown as SessionMessage[]
    expect(() => mergeNativeMessages(messages, [])).not.toThrow()
  })
})
