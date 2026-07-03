// F0: stored V2-native history -> v1 WithParts projection (message-v2-native.ts).
// The mapper mirrors the LIVE translator (event-v2-translate.ts): same part ids
// (content ids verbatim; deterministic `${messageID}-text` for user prompts),
// same tool-state shaping — so a fetch overlapping live streaming collapses
// into the same parts instead of duplicating bubbles.
import { describe, expect, test } from "bun:test"
import { nativeWithParts, type RawNativeRow } from "../../src/session/message-v2-native"
import { userFilePartID, userTextPartID } from "../../src/event-v2-translate"

const SES = "ses_test123"

const userRow = (id: string, time: number, data: Record<string, unknown> = {}): RawNativeRow => ({
  id,
  type: "user",
  time_created: time,
  data: { text: "hello", time: { created: time }, ...data },
})

const assistantRow = (id: string, time: number, data: Record<string, unknown> = {}): RawNativeRow => ({
  id,
  type: "assistant",
  time_created: time,
  data: {
    agent: "build",
    model: { id: "qwen3.6-35b", providerID: "dgx-spark" },
    content: [],
    time: { created: time },
    ...data,
  },
})

describe("nativeWithParts", () => {
  test("user row -> v1 user info + deterministic text part id", () => {
    const [item] = nativeWithParts([userRow("msg_u1", 1000)], SES)
    expect(item!.info).toMatchObject({ id: "msg_u1", sessionID: SES, role: "user", time: { created: 1000 } })
    const [part] = item!.parts
    expect(part).toMatchObject({
      id: userTextPartID("msg_u1"),
      type: "text",
      text: "hello",
      messageID: "msg_u1",
    })
  })

  test("user files -> file parts with deterministic ids (uri->url)", () => {
    const [item] = nativeWithParts(
      [userRow("msg_u2", 1000, { files: [{ uri: "data:image/png;base64,AAA", mime: "image/png", name: "a.png" }] })],
      SES,
    )
    expect(item!.parts).toHaveLength(2)
    expect(item!.parts[1]).toMatchObject({
      id: userFilePartID("msg_u2", 0),
      type: "file",
      url: "data:image/png;base64,AAA",
      mime: "image/png",
      filename: "a.png",
    })
  })

  test("assistant row -> info with model/agent/tokens + text/reasoning parts under CONTENT ids", () => {
    const rows = [
      userRow("msg_u1", 1000),
      assistantRow("msg_a1", 2000, {
        content: [
          { type: "reasoning", id: "reasoning-0", text: "thinking...", time: { created: 2000, completed: 2100 } },
          { type: "text", id: "text-0", text: "the answer" },
        ],
        finish: "stop",
        cost: 0,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
        time: { created: 2000, completed: 2500 },
      }),
    ]
    const items = nativeWithParts(rows, SES)
    expect(items).toHaveLength(2)
    const assistant = items[1]!
    expect(assistant.info).toMatchObject({
      id: "msg_a1",
      role: "assistant",
      parentID: "msg_u1", // grouped under the preceding user turn
      modelID: "qwen3.6-35b",
      providerID: "dgx-spark",
      agent: "build",
      finish: "stop",
      tokens: { input: 10, output: 5, reasoning: 2 },
      time: { created: 2000, completed: 2500 },
    })
    // Part ids are the V2 content ids VERBATIM (live-translator parity).
    expect(assistant.parts[0]).toMatchObject({ id: "reasoning-0", type: "reasoning", text: "thinking..." })
    expect(assistant.parts[1]).toMatchObject({ id: "text-0", type: "text", text: "the answer" })
  })

  test("assistant with no preceding user row -> parentID falls back to its own id", () => {
    const [item] = nativeWithParts([assistantRow("msg_a1", 2000)], SES)
    expect((item!.info as { parentID?: string }).parentID).toBe("msg_a1")
  })

  test("tool content -> ToolPart with callID = content id; completed/error states shaped like the live translator", () => {
    const rows = [
      assistantRow("msg_a1", 2000, {
        content: [
          {
            type: "tool",
            id: "call_1",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              content: [{ type: "text", text: "file.txt" }],
              structured: {},
            },
            time: { created: 2000, ran: 2050, completed: 2100 },
          },
          {
            type: "tool",
            id: "call_2",
            name: "read",
            state: {
              status: "error",
              input: { filePath: "x" },
              content: [],
              structured: {},
              error: { type: "unknown", message: "boom" },
            },
            time: { created: 2200, completed: 2300 },
          },
        ],
      }),
    ]
    const [item] = nativeWithParts(rows, SES)
    expect(item!.parts[0]).toMatchObject({
      id: "call_1",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "ls" },
        output: "file.txt",
        title: "bash",
        time: { start: 2050, end: 2100 },
      },
    })
    expect(item!.parts[1]).toMatchObject({
      id: "call_2",
      type: "tool",
      tool: "read",
      state: { status: "error", error: "boom", time: { start: 2200, end: 2300 } },
    })
  })

  test("running + pending tool states map (running keeps input; pending keeps raw)", () => {
    const rows = [
      assistantRow("msg_a1", 2000, {
        content: [
          { type: "tool", id: "c1", name: "grep", state: { status: "pending", input: '{"pat' }, time: { created: 2000 } },
          {
            type: "tool",
            id: "c2",
            name: "glob",
            state: { status: "running", input: { pattern: "*" }, content: [], structured: {} },
            time: { created: 2100 },
          },
        ],
      }),
    ]
    const [item] = nativeWithParts(rows, SES)
    expect(item!.parts[0]).toMatchObject({ state: { status: "pending", raw: '{"pat' } })
    expect(item!.parts[1]).toMatchObject({ state: { status: "running", input: { pattern: "*" } } })
  })

  test("non-renderable row types are dropped (mirrors the live translator's drops)", () => {
    const rows: RawNativeRow[] = [
      { id: "msg_s1", type: "synthetic", time_created: 100, data: { text: "steer" } },
      { id: "msg_sh1", type: "shell", time_created: 200, data: { callID: "c", command: "ls", output: "" } },
      { id: "msg_c1", type: "compaction", time_created: 300, data: { reason: "auto", summary: "s", recent: "r" } },
      { id: "msg_ag1", type: "agent-switched", time_created: 400, data: { agent: "plan" } },
      userRow("msg_u1", 500),
    ]
    const items = nativeWithParts(rows, SES)
    expect(items).toHaveLength(1)
    expect(String(items[0]!.info.id)).toBe("msg_u1")
  })

  test("rows sort ascending by time_created (ties by id) regardless of input order", () => {
    const items = nativeWithParts([assistantRow("msg_a1", 3000), userRow("msg_u1", 1000), userRow("msg_u2", 2000)], SES)
    expect(items.map((item) => String(item.info.id))).toEqual(["msg_u1", "msg_u2", "msg_a1"])
    // the assistant parents under the LATEST preceding user
    expect((items[2]!.info as { parentID?: string }).parentID).toBe("msg_u2")
  })
})
