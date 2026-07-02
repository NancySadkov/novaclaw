import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { createStore } from "solid-js/store"
import { createTranslator, type BridgeEvent, type LegacyEnvelope } from "@/event-v2-translate"
import { createSessionData, reduceSessionData } from "@/cli/cmd/run/session-data"
import type { Event as SdkEvent } from "@novaclaw/sdk/v2"

// The desktop reducer lives in @novaclaw/app, which is not a dependency of
// this package and does not export this subpath. We load it at RUNTIME via a
// dynamic relative import (resolved fine by bun's workspace), typed loosely so
// tsgo does not traverse the app's JSX/UI module graph under this package's
// (incompatible) tsconfig and surface the app's own pre-existing type errors.
// The round-trip still exercises the REAL, unchanged client reducer.
type ApplyDirectoryEvent = (input: {
  event: { type: string; properties?: unknown }
  store: any
  setStore: any
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
}) => void
type State = Record<string, any>
async function loadDesktopReducer(): Promise<ApplyDirectoryEvent> {
  // Non-literal specifier on purpose: keeps tsgo from resolving/type-checking
  // the app source graph under this package's tsconfig (see note above). bun
  // resolves it fine at runtime.
  const spec = ["..", "..", "app", "src", "context", "global-sync", "event-reducer"].join("/")
  const mod = (await import(spec)) as { applyDirectoryEvent: ApplyDirectoryEvent }
  return mod.applyDirectoryEvent
}

// ---------------------------------------------------------------------------
// Helpers to build V2 bridge events. The bridge delivers decoded payloads, so
// `timestamp` is a DateTime.Utc. We build them that way to exercise the real
// DateTime->millis conversion path.
// ---------------------------------------------------------------------------

const SES = "ses_test"
const MSG = "msg_assistant1"

function ev(type: string, data: Record<string, unknown>): BridgeEvent {
  return { type, data: { sessionID: SES, ...data } }
}

function ts(ms: number) {
  return DateTime.makeUnsafe(ms)
}

function stepStarted(input: { messageID?: string; ms?: number; agent?: string; model?: any } = {}) {
  return ev("session.next.step.started", {
    assistantMessageID: input.messageID ?? MSG,
    agent: input.agent ?? "build",
    model: input.model ?? { id: "gpt-5", providerID: "openai" },
    timestamp: ts(input.ms ?? 1000),
  })
}

function stepEnded(input: { messageID?: string; ms?: number; finish?: string } = {}) {
  return ev("session.next.step.ended", {
    assistantMessageID: input.messageID ?? MSG,
    finish: input.finish ?? "stop",
    cost: 0.01,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    timestamp: ts(input.ms ?? 2000),
  })
}

function stepFailed(input: { messageID?: string; ms?: number; error?: unknown } = {}) {
  return ev("session.next.step.failed", {
    assistantMessageID: input.messageID ?? MSG,
    error: input.error ?? { type: "unknown", message: "boom" },
    timestamp: ts(input.ms ?? 2000),
  })
}

function prompted(input: {
  messageID?: string
  text: string
  files?: Array<{ uri: string; mime?: string; name?: string }>
  agents?: Array<{ name: string }>
  ms?: number
} = { text: "hi" }) {
  return ev("session.next.prompted", {
    messageID: input.messageID ?? "msg_user1",
    prompt: { text: input.text, ...(input.files ? { files: input.files } : {}), ...(input.agents ? { agents: input.agents } : {}) },
    delivery: "steer",
    timestamp: ts(input.ms ?? 900),
  })
}

function textStarted(textID: string, ms = 1100) {
  return ev("session.next.text.started", { assistantMessageID: MSG, textID, timestamp: ts(ms) })
}
function textDelta(textID: string, delta: string, ms = 1200) {
  return ev("session.next.text.delta", { assistantMessageID: MSG, textID, delta, timestamp: ts(ms) })
}
function textEnded(textID: string, text: string, ms = 1300) {
  return ev("session.next.text.ended", { assistantMessageID: MSG, textID, text, timestamp: ts(ms) })
}

function reasoningStarted(reasoningID: string, ms = 1050) {
  return ev("session.next.reasoning.started", { assistantMessageID: MSG, reasoningID, timestamp: ts(ms) })
}
function reasoningDelta(reasoningID: string, delta: string, ms = 1060) {
  return ev("session.next.reasoning.delta", { assistantMessageID: MSG, reasoningID, delta, timestamp: ts(ms) })
}
function reasoningEnded(reasoningID: string, text: string, ms = 1070) {
  return ev("session.next.reasoning.ended", { assistantMessageID: MSG, reasoningID, text, timestamp: ts(ms) })
}

function toolInputStarted(callID: string, name: string, ms = 1400) {
  return ev("session.next.tool.input.started", { assistantMessageID: MSG, callID, name, timestamp: ts(ms) })
}
function toolInputEnded(callID: string, text: string, ms = 1410) {
  return ev("session.next.tool.input.ended", { assistantMessageID: MSG, callID, text, timestamp: ts(ms) })
}
function toolCalled(callID: string, tool: string, input: Record<string, unknown>, ms = 1420) {
  return ev("session.next.tool.called", {
    assistantMessageID: MSG,
    callID,
    tool,
    input,
    provider: { executed: true },
    timestamp: ts(ms),
  })
}
function toolSuccess(callID: string, content: Array<{ type: "text"; text: string }>, ms = 1500) {
  return ev("session.next.tool.success", {
    assistantMessageID: MSG,
    callID,
    structured: {},
    content,
    provider: { executed: true },
    timestamp: ts(ms),
  })
}
function toolFailed(callID: string, error: unknown, ms = 1500) {
  return ev("session.next.tool.failed", {
    assistantMessageID: MSG,
    callID,
    error,
    provider: { executed: true },
    timestamp: ts(ms),
  })
}

// pull the single envelope, asserting exactly one
function only(envelopes: LegacyEnvelope[]): LegacyEnvelope {
  expect(envelopes).toHaveLength(1)
  return envelopes[0]!
}

describe("event-v2-translate / golden per-event shapes", () => {
  test("step.started -> message.updated with assistant role, zeroed cost/tokens", () => {
    const t = createTranslator()
    const env = only(t.translate(stepStarted()))
    expect(env.type).toBe("message.updated")
    const info = (env.properties as any).info
    expect((env.properties as any).sessionID).toBe(SES)
    expect(info).toMatchObject({
      id: MSG,
      sessionID: SES,
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5",
      agent: "build",
      mode: "build",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1000 },
    })
    expect(info.time.completed).toBeUndefined()
    expect(info.path).toEqual({ cwd: "", root: "" })
  })

  test("step.ended -> message.updated finalizing cost/tokens/finish/time.completed (NO turn terminal)", () => {
    const t = createTranslator()
    t.translate(stepStarted())
    const env = only(t.translate(stepEnded()))
    expect(env.type).toBe("message.updated")
    const info = (env.properties as any).info
    expect(info).toMatchObject({
      id: MSG,
      role: "assistant",
      cost: 0.01,
      finish: "stop",
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { completed: 2000 },
    })
  })

  test("step.failed -> message.updated with finish=error and extracted error message", () => {
    const t = createTranslator()
    t.translate(stepStarted())
    const env = only(t.translate(stepFailed({ error: { type: "unknown", message: "kaboom" } })))
    const info = (env.properties as any).info
    expect(info.finish).toBe("error")
    expect(info.error).toEqual({ name: "UnknownError", data: { message: "kaboom" } })
  })

  test("prompted then step.failed -> failed assistant row parents under the user messageID (visible Error card)", () => {
    const t = createTranslator()
    t.translate(prompted({ messageID: "msg_user1", text: "hi" }))
    const env = only(
      t.translate(stepFailed({ error: { type: "unknown", message: "HTTP transport failed (target http://127.0.0.1:1)" } })),
    )
    const info = (env.properties as any).info
    // The desktop groups assistant rows by parentID under the user message id;
    // this is what makes the red Error card render instead of being orphaned.
    expect(info.parentID).toBe("msg_user1")
    expect(info.id).toBe(MSG)
    expect(info.finish).toBe("error")
    expect(info.error.data.message).toBe("HTTP transport failed (target http://127.0.0.1:1)")
  })

  test("prompted then a full step -> started/ended assistant rows also parent under the user messageID", () => {
    const t = createTranslator()
    t.translate(prompted({ messageID: "msg_user1", text: "hi" }))
    const startInfo = (only(t.translate(stepStarted())).properties as any).info
    expect(startInfo.parentID).toBe("msg_user1")
    const endInfo = (only(t.translate(stepEnded())).properties as any).info
    expect(endInfo.parentID).toBe("msg_user1")
  })

  test("step.failed with NO prior prompted -> still emits; parentID falls back to its own id (no crash)", () => {
    const t = createTranslator()
    const env = only(t.translate(stepFailed({ error: { type: "unknown", message: "boom" } })))
    const info = (env.properties as any).info
    expect(info.parentID).toBe(MSG) // falls back to own message id
    expect(info.finish).toBe("error")
    expect(info.error.data.message).toBe("boom")
  })

  test("text.started -> empty TextPart with time.start; delta -> part.delta; ended -> full part + time.end", () => {
    const t = createTranslator()
    t.translate(stepStarted())

    const startedEnv = only(t.translate(textStarted("txt-1")))
    expect(startedEnv.type).toBe("message.part.updated")
    const startPart = (startedEnv.properties as any).part
    expect(startPart).toMatchObject({ type: "text", text: "", sessionID: SES, messageID: MSG })
    // The legacy part id is the V2 textID verbatim (NOT a minted prt_…) so the live
    // part and the fetched part (server-session, same V2 id) dedup to one bubble.
    expect(startPart.id).toBe("txt-1")
    expect(startPart.time).toEqual({ start: 1100 })
    const partID = startPart.id

    const deltaEnv = only(t.translate(textDelta("txt-1", "hello")))
    expect(deltaEnv.type).toBe("message.part.delta")
    expect(deltaEnv.properties).toMatchObject({
      sessionID: SES,
      messageID: MSG,
      partID,
      field: "text",
      delta: "hello",
    })

    const endedEnv = only(t.translate(textEnded("txt-1", "hello world")))
    expect(endedEnv.type).toBe("message.part.updated")
    const endPart = (endedEnv.properties as any).part
    expect(endPart.id).toBe(partID) // stable part id across create/delta/final
    expect(endPart.text).toBe("hello world")
    expect(endPart.time).toMatchObject({ end: 1300 })
  })

  test("reasoning.* mirrors text.* with reasoning parts", () => {
    const t = createTranslator()
    t.translate(stepStarted())
    const startedEnv = only(t.translate(reasoningStarted("r-1")))
    const startPart = (startedEnv.properties as any).part
    expect(startPart).toMatchObject({ type: "reasoning", text: "" })
    const partID = startPart.id

    const deltaEnv = only(t.translate(reasoningDelta("r-1", "mm")))
    expect(deltaEnv.properties).toMatchObject({ partID, field: "text", delta: "mm" })

    const endedEnv = only(t.translate(reasoningEnded("r-1", "done thinking")))
    const endPart = (endedEnv.properties as any).part
    expect(endPart.id).toBe(partID)
    expect(endPart.text).toBe("done thinking")
    expect(endPart.time.end).toBe(1070)
  })

  test("prompted -> user message.updated + text part with the prompt text", () => {
    const t = createTranslator()
    const envs = t.translate(prompted({ messageID: "msg_user1", text: "hello world", ms: 900 }))
    // user row first, then its text part (ordering matches the assistant path)
    expect(envs.map((e) => e.type)).toEqual(["message.updated", "message.part.updated"])

    const info = (envs[0]!.properties as any).info
    expect((envs[0]!.properties as any).sessionID).toBe(SES)
    expect(info).toMatchObject({ id: "msg_user1", sessionID: SES, role: "user", time: { created: 900 } })

    const part = (envs[1]!.properties as any).part
    expect(part).toMatchObject({ type: "text", text: "hello world", sessionID: SES, messageID: "msg_user1" })
    expect(part.id.startsWith("prt")).toBe(true)
  })

  test("prompted with file attachments -> file parts (uri->url, no mime required)", () => {
    const t = createTranslator()
    const envs = t.translate(
      prompted({
        messageID: "msg_user2",
        text: "see attached",
        files: [{ uri: "file:///a.txt", mime: "text/plain", name: "a.txt" }],
      }),
    )
    expect(envs.map((e) => e.type)).toEqual(["message.updated", "message.part.updated", "message.part.updated"])
    const filePart = (envs[2]!.properties as any).part
    expect(filePart).toMatchObject({
      type: "file",
      url: "file:///a.txt",
      mime: "text/plain",
      filename: "a.txt",
      messageID: "msg_user2",
    })
  })

  test("prompt.admitted still drops (only prompted creates the user row)", () => {
    const t = createTranslator()
    expect(t.translate(ev("session.next.prompt.admitted", { messageID: "msg_x", prompt: { text: "x" } }))).toEqual([])
  })

  test("dropped events translate to []", () => {
    const t = createTranslator()
    for (const type of [
      "session.next.moved",
      "session.next.prompt.admitted",
      "session.next.retried",
      "session.next.compaction.started",
      "session.next.compaction.ended",
      "session.next.revert.staged",
      "session.next.agent.switched",
      "session.next.model.switched",
      "session.next.tool.input.delta",
      "session.next.tool.progress",
      "session.next.shell.started",
      "session.next.shell.ended",
      "session.next.context.updated",
      "session.next.synthetic",
    ]) {
      expect(t.translate(ev(type, {}))).toEqual([])
    }
  })

  test("events without a sessionID are dropped", () => {
    const t = createTranslator()
    expect(t.translate({ type: "session.next.step.started", data: {} })).toEqual([])
  })
})

describe("event-v2-translate / tool lifecycle", () => {
  test("input.started -> called -> success: pending -> running -> completed, stable ids, flat output", () => {
    const t = createTranslator()
    t.translate(stepStarted())

    const startedEnv = only(t.translate(toolInputStarted("call-1", "bash")))
    const pendingPart = (startedEnv.properties as any).part
    expect(pendingPart).toMatchObject({ type: "tool", callID: "call-1", tool: "bash" })
    expect(pendingPart.state.status).toBe("pending")
    const partID = pendingPart.id
    // The legacy tool part id is the V2 callID verbatim so it dedups with the fetch.
    expect(partID).toBe("call-1")

    // input.ended itself is not a streaming target -> []
    expect(t.translate(toolInputEnded("call-1", '{"command":"ls"}'))).toEqual([])

    const calledEnv = only(t.translate(toolCalled("call-1", "bash", { command: "ls" })))
    const runningPart = (calledEnv.properties as any).part
    expect(runningPart.id).toBe(partID)
    expect(runningPart.callID).toBe("call-1")
    expect(runningPart.tool).toBe("bash")
    expect(runningPart.state).toMatchObject({ status: "running", input: { command: "ls" } })
    expect(runningPart.state.time.start).toBe(1400)

    const successEnv = only(
      t.translate(
        toolSuccess("call-1", [
          { type: "text", text: "file1\n" },
          { type: "text", text: "file2\n" },
        ]),
      ),
    )
    const completedPart = (successEnv.properties as any).part
    expect(completedPart.id).toBe(partID)
    expect(completedPart.tool).toBe("bash")
    expect(completedPart.state).toMatchObject({
      status: "completed",
      input: { command: "ls" },
      output: "file1\nfile2\n", // flattened text content
      title: "bash",
      metadata: {},
    })
    expect(completedPart.state.time).toMatchObject({ start: 1400, end: 1500 })
  })

  test("failed path extracts a flat error string and never the V2 error object", () => {
    const t = createTranslator()
    t.translate(stepStarted())
    t.translate(toolInputStarted("call-2", "read"))
    t.translate(toolCalled("call-2", "read", { path: "/x" }))
    const failedEnv = only(t.translate(toolFailed("call-2", { type: "unknown", message: "ENOENT" })))
    const errPart = (failedEnv.properties as any).part
    expect(errPart.state.status).toBe("error")
    expect(errPart.state.error).toBe("ENOENT")
    expect(typeof errPart.state.error).toBe("string")
    expect(errPart.tool).toBe("read")
    expect(errPart.callID).toBe("call-2")
  })

  test("tool.called without prior input.started still yields a ToolPart with tool + callID", () => {
    const t = createTranslator()
    t.translate(stepStarted())
    const env = only(t.translate(toolCalled("call-3", "grep", { pattern: "x" })))
    const part = (env.properties as any).part
    expect(part).toMatchObject({ type: "tool", callID: "call-3", tool: "grep" })
    expect(part.state.status).toBe("running")
  })
})

describe("event-v2-translate / multi-step turn (the #1 showstopper)", () => {
  test("replaying a tool-using two-step turn never emits a turn-terminal/idle/status envelope", () => {
    const t = createTranslator()
    const script: BridgeEvent[] = [
      stepStarted({ ms: 1000 }),
      textStarted("txt-1", 1010),
      textDelta("txt-1", "let me check", 1020),
      textEnded("txt-1", "let me check", 1030),
      toolInputStarted("call-1", "bash", 1040),
      toolCalled("call-1", "bash", { command: "ls" }, 1050),
      toolSuccess("call-1", [{ type: "text", text: "ok" }], 1060),
      stepEnded({ ms: 1070 }), // end of provider step 1 (mid-turn!)
      stepStarted({ ms: 1080 }),
      textStarted("txt-2", 1090),
      textDelta("txt-2", "done", 1100),
      textEnded("txt-2", "done", 1110),
      stepEnded({ ms: 1120 }), // end of provider step 2
    ]

    const all: LegacyEnvelope[] = []
    for (const e of script) all.push(...t.translate(e))

    // Only the three legacy event types should appear.
    const types = new Set(all.map((e) => e.type))
    expect([...types].sort()).toEqual(["message.part.delta", "message.part.updated", "message.updated"])

    // No idle / status / turn-completion envelope of any kind.
    for (const e of all) {
      expect(e.type).not.toContain("status")
      expect(e.type).not.toContain("idle")
      expect(e.type).not.toBe("session.idle")
    }

    // The mid-turn step.ended produced a message.updated that finalizes the
    // assistant Info but does NOT remove/complete the turn: a SECOND step.started
    // produced another assistant message.updated for the same id afterwards.
    const messageUpdates = all.filter((e) => e.type === "message.updated")
    // step.started x2 + step.ended x2 = 4 message.updated rows
    expect(messageUpdates).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// Round-trip through the REAL desktop reducer.
// ---------------------------------------------------------------------------

function baseDesktopState(): State {
  return {
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    part_text_accum_delta: {},
    // The reducer reads only a subset of State; cast through unknown so newer
    // required fields (provider_ready, session_working, mcp_ready, lsp_ready)
    // don't force us to fabricate values the reducer never touches.
  } as unknown as State
}

describe("event-v2-translate / round-trip through the desktop reducer", () => {
  test("a full single-step turn renders assistant message + accumulated text + completed tool", async () => {
    const applyDirectoryEvent = await loadDesktopReducer()
    const t = createTranslator()
    const [store, setStore] = createStore(baseDesktopState())

    const feed = (e: BridgeEvent) => {
      for (const env of t.translate(e)) {
        applyDirectoryEvent({
          event: env,
          store,
          setStore,
          push() {},
          directory: "/tmp",
          loadLsp() {},
        })
      }
    }

    feed(stepStarted())
    feed(textStarted("txt-1", 1100))
    feed(textDelta("txt-1", "hel", 1110))
    feed(textDelta("txt-1", "lo", 1120))
    feed(textEnded("txt-1", "hello", 1130))
    feed(toolInputStarted("call-1", "bash", 1200))
    feed(toolCalled("call-1", "bash", { command: "ls" }, 1210))
    feed(toolSuccess("call-1", [{ type: "text", text: "file1\n" }], 1220))
    feed(stepEnded())

    // assistant message landed in the store, keyed by sessionID
    const messages = store.message[SES]
    expect(messages).toBeDefined()
    const assistant = messages!.find((m: any) => m.id === MSG)
    expect(assistant?.role).toBe("assistant")
    expect((assistant as any).cost).toBe(0.01)
    expect((assistant as any).finish).toBe("stop")

    // parts keyed by messageID
    const parts = store.part[MSG]
    expect(parts).toBeDefined()
    const textPart = parts!.find((p: any) => p.type === "text")
    expect(textPart).toBeDefined()
    // text.ended overwrote with the full value
    expect((textPart as any).text).toBe("hello")

    const toolPart = parts!.find((p: any) => p.type === "tool")
    expect(toolPart).toBeDefined()
    expect((toolPart as any).state.status).toBe("completed")
    expect((toolPart as any).state.output).toBe("file1\n")
    expect((toolPart as any).tool).toBe("bash")
  })

  test("the fetched part and the live translated part dedup to ONE (no doubled response)", async () => {
    // The desktop has TWO writers for an assistant's parts: the live translated events
    // (this translator) AND the client.session.messages fetch, which returns the V2
    // content part under its V2 stream id (e.g. "txt-1"). Before the fix the translator
    // minted a random prt_… id that never matched the fetch -> TWO text parts -> a
    // doubled bubble. Now both use the V2 id, so the reducer's dedup-by-id (the same
    // Binary.search mechanism the server-session store uses at server-session.ts:814)
    // collapses them to one. This reproduces the actual two-writer bug, which the
    // earlier single-writer round-trips could not.
    const applyDirectoryEvent = await loadDesktopReducer()
    const t = createTranslator()
    const [store, setStore] = createStore(baseDesktopState())
    const apply = (env: { type: string; properties?: unknown }) =>
      applyDirectoryEvent({ event: env, store, setStore, push() {}, directory: "/tmp", loadLsp() {} })
    const feed = (e: BridgeEvent) => t.translate(e).forEach(apply)

    // live writer: a streamed text turn -> part id == the V2 textID "txt-1"
    feed(stepStarted())
    feed(textStarted("txt-1", 1100))
    feed(textDelta("txt-1", "hello", 1110))
    feed(textEnded("txt-1", "hello", 1130))
    feed(stepEnded())

    // fetch writer: client.session.messages returns the SAME assistant part under its
    // V2 id "txt-1" (this is what the desktop stores from the fetch).
    apply({
      type: "message.part.updated",
      properties: {
        part: { id: "txt-1", sessionID: SES, messageID: MSG, type: "text", text: "hello", time: { start: 1100, end: 1130 } },
      },
    })

    const textParts = (store.part[MSG] ?? []).filter((p: any) => p.type === "text")
    expect(textParts).toHaveLength(1) // one part, not two -> a single rendered bubble
    expect((textParts[0] as any).id).toBe("txt-1")
    expect((textParts[0] as any).text).toBe("hello")
  })

  test("a prompted user message renders in the store (row + text part)", async () => {
    const applyDirectoryEvent = await loadDesktopReducer()
    const t = createTranslator()
    const [store, setStore] = createStore(baseDesktopState())
    const feed = (e: BridgeEvent) => {
      for (const env of t.translate(e)) {
        applyDirectoryEvent({ event: env, store, setStore, push() {}, directory: "/tmp", loadLsp() {} })
      }
    }

    feed(prompted({ messageID: "msg_user1", text: "what is 2+2?", ms: 900 }))

    // the user message landed in the store keyed by sessionID
    const messages = store.message[SES]
    expect(messages).toBeDefined()
    const user = messages!.find((m: any) => m.id === "msg_user1")
    expect(user?.role).toBe("user")

    // the prompt text rendered as a text part keyed by messageID
    const parts = store.part["msg_user1"]
    expect(parts).toBeDefined()
    const textPart = parts!.find((p: any) => p.type === "text")
    expect((textPart as any).text).toBe("what is 2+2?")
  })

  test("text deltas accumulate through the reducer's part_text_accum_delta", async () => {
    const applyDirectoryEvent = await loadDesktopReducer()
    const t = createTranslator()
    const [store, setStore] = createStore(baseDesktopState())
    const feed = (e: BridgeEvent) => {
      for (const env of t.translate(e)) {
        applyDirectoryEvent({ event: env, store, setStore, push() {}, directory: "/tmp", loadLsp() {} })
      }
    }
    feed(stepStarted())
    feed(textStarted("txt-1", 1100))
    feed(textDelta("txt-1", "foo", 1110))
    feed(textDelta("txt-1", "bar", 1120))

    const part = store.part[MSG]!.find((p: any) => p.type === "text")!
    expect((part as any).text).toBe("foobar")
  })
})

// ---------------------------------------------------------------------------
// Round-trip through the REAL CLI reducer.
// ---------------------------------------------------------------------------

describe("event-v2-translate / round-trip through the CLI reducer", () => {
  test("renders assistant text + tool without error", () => {
    const t = createTranslator()
    let data = createSessionData()
    const commits: any[] = []
    const feed = (e: BridgeEvent) => {
      for (const env of t.translate(e)) {
        const out = reduceSessionData({
          data,
          event: env as unknown as SdkEvent,
          sessionID: SES,
          thinking: true,
          limits: {},
        })
        data = out.data
        commits.push(...out.commits)
      }
    }

    feed(stepStarted())
    feed(textStarted("txt-1", 1100))
    feed(textDelta("txt-1", "hello ", 1110))
    feed(textDelta("txt-1", "world", 1120))
    feed(textEnded("txt-1", "hello world", 1130))
    feed(toolInputStarted("call-1", "bash", 1200))
    feed(toolCalled("call-1", "bash", { command: "ls" }, 1210))
    feed(toolSuccess("call-1", [{ type: "text", text: "file1\n" }], 1220))
    feed(stepEnded())

    // assistant text flushed to scrollback
    const assistantText = commits
      .filter((c) => c.kind === "assistant")
      .map((c) => c.text)
      .join("")
    expect(assistantText).toContain("hello world")

    // tool commits present, started + completed, no error commit
    const toolCommits = commits.filter((c) => c.kind === "tool")
    expect(toolCommits.length).toBeGreaterThan(0)
    expect(toolCommits.some((c) => c.phase === "start")).toBe(true)
    expect(commits.some((c) => c.kind === "error")).toBe(false)
  })

  test("tool failure surfaces an error commit through the CLI reducer", () => {
    const t = createTranslator()
    let data = createSessionData()
    const commits: any[] = []
    const feed = (e: BridgeEvent) => {
      for (const env of t.translate(e)) {
        const out = reduceSessionData({
          data,
          event: env as unknown as SdkEvent,
          sessionID: SES,
          thinking: true,
          limits: {},
        })
        data = out.data
        commits.push(...out.commits)
      }
    }
    feed(stepStarted())
    feed(toolInputStarted("call-1", "glob", 1200))
    feed(toolCalled("call-1", "glob", { pattern: "**/x" }, 1210))
    feed(toolFailed("call-1", { type: "unknown", message: "no such dir" }, 1220))

    const failCommit = commits.find((c) => c.kind === "tool" && c.toolState === "error")
    expect(failCommit).toBeDefined()
    expect(failCommit.toolError).toBe("no such dir")
  })
})

// ---------------------------------------------------------------------------
// Ordering and interleaving invariants.
// ---------------------------------------------------------------------------

describe("event-v2-translate / ordering invariant", () => {
  test("message.updated(role) precedes part create, and part.updated(create) precedes part.delta", () => {
    const t = createTranslator()
    const seq: LegacyEnvelope[] = []
    seq.push(...t.translate(stepStarted()))
    seq.push(...t.translate(textStarted("txt-1")))
    seq.push(...t.translate(textDelta("txt-1", "x")))

    const idxMessageUpdated = seq.findIndex((e) => e.type === "message.updated")
    const idxPartCreate = seq.findIndex((e) => e.type === "message.part.updated")
    const idxDelta = seq.findIndex((e) => e.type === "message.part.delta")

    expect(idxMessageUpdated).toBeGreaterThanOrEqual(0)
    expect(idxPartCreate).toBeGreaterThan(idxMessageUpdated)
    expect(idxDelta).toBeGreaterThan(idxPartCreate)
  })
})

describe("event-v2-translate / interleaving", () => {
  test("part id is the V2 stream id; same textID across sessions is scoped by messageID", () => {
    const t = createTranslator()
    const sesA = "ses_A"
    const sesB = "ses_B"

    const startA = { type: "session.next.step.started", data: { sessionID: sesA, assistantMessageID: "msg_A", agent: "build", model: { id: "m", providerID: "p" }, timestamp: ts(1) } } satisfies BridgeEvent
    const startB = { type: "session.next.step.started", data: { sessionID: sesB, assistantMessageID: "msg_B", agent: "build", model: { id: "m", providerID: "p" }, timestamp: ts(1) } } satisfies BridgeEvent
    const textA = { type: "session.next.text.started", data: { sessionID: sesA, assistantMessageID: "msg_A", textID: "txt", timestamp: ts(2) } } satisfies BridgeEvent
    const textB = { type: "session.next.text.started", data: { sessionID: sesB, assistantMessageID: "msg_B", textID: "txt", timestamp: ts(2) } } satisfies BridgeEvent

    t.translate(startA)
    t.translate(startB)
    const partA = (only(t.translate(textA)).properties as any).part
    const partB = (only(t.translate(textB)).properties as any).part

    // The part id is the V2 textID verbatim, so the SAME textID across two sessions
    // yields the same part id — but parts are scoped per messageID, so they never
    // collide, and each dedups with its own session's fetched part (the bug fix).
    expect(partA.id).toBe("txt")
    expect(partB.id).toBe("txt")
    expect(partA.messageID).toBe("msg_A")
    expect(partB.messageID).toBe("msg_B")
  })
})
