// F1c-0 — the export sanitizer over the NATIVE message union (the redaction walk that
// replaced the V1 part walk): every user-content string is redacted, structure/ids/times
// survive, and the sanitized value still ENCODES through the wire schema (the export path
// encodes after sanitizing, so schema conformance is part of the contract).
import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { SessionMessage } from "@novaclaw/core/session/message"
import { sanitizeMessage } from "../../src/cli/cmd/export"

const created = DateTime.makeUnsafe(0)
const encodeMessages = Schema.encodeSync(Schema.Array(SessionMessage.Message))

const user: SessionMessage.User = {
  id: SessionMessage.ID.make("msg_user"),
  type: "user",
  text: "secret prompt",
  files: [
    {
      uri: "file:///home/nancy/secrets.txt",
      mime: "text/plain",
      name: "secrets.txt",
      description: "the plan",
      source: { start: 0, end: 5, text: "top secret span" },
    },
  ],
  agents: [{ name: "build", source: { start: 0, end: 6, text: "@build" } }],
  metadata: { origin: "test" },
  time: { created },
}

const assistant: SessionMessage.Assistant = {
  id: SessionMessage.ID.make("msg_assistant"),
  type: "assistant",
  agent: "build",
  model: { id: "qwen" as SessionMessage.Assistant["model"]["id"], providerID: "dgx-spark" as SessionMessage.Assistant["model"]["providerID"] },
  content: [
    { type: "text", id: "txt_1", text: "the answer" },
    { type: "reasoning", id: "rsn_1", text: "thinking about secrets" },
    {
      type: "tool",
      id: "tool_1",
      name: "read",
      state: {
        status: "completed",
        input: { filePath: "/home/nancy/secrets.txt" },
        structured: { lines: 3 },
        content: [
          { type: "text", text: "file contents" },
          { type: "file", uri: "file:///tmp/out.png", mime: "image/png", name: "out.png" },
        ],
        attachments: [{ uri: "file:///tmp/att.txt", mime: "text/plain" }],
        outputPaths: ["/home/nancy/out.txt"],
        result: { raw: "sensitive" },
      },
      time: { created },
    },
    {
      type: "tool",
      id: "tool_2",
      name: "bash",
      state: {
        status: "error",
        input: { command: "cat /etc/passwd" },
        structured: {},
        content: [],
        error: { type: "unknown", message: "boom: /etc/passwd" },
      },
      time: { created },
    },
  ],
  error: { type: "unknown", message: "provider exploded" },
  cost: 0,
  tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
  time: { created },
}

const shell: SessionMessage.Shell = {
  id: SessionMessage.ID.make("msg_shell"),
  type: "shell",
  callID: "tool_3",
  command: "rm -rf /secrets",
  output: "gone",
  time: { created },
}

const compaction: SessionMessage.Compaction = {
  id: SessionMessage.ID.make("msg_compaction"),
  type: "compaction",
  reason: "auto",
  summary: "we discussed secrets",
  recent: "recent secrets",
  time: { created },
}

const switched: SessionMessage.AgentSwitched = {
  id: SessionMessage.ID.make("msg_switch"),
  type: "agent-switched",
  agent: "plan",
  time: { created },
}

describe("export sanitizeMessage", () => {
  test("redacts every user-content string and keeps structure", () => {
    const out = sanitizeMessage(user) as SessionMessage.User
    expect(out.id).toBe(user.id)
    expect(out.text).toBe("[redacted:text:msg_user]")
    expect(out.files?.[0]?.uri).toBe("[redacted:file-uri:msg_user]")
    expect(out.files?.[0]?.name).toBe("[redacted:file-name:msg_user]")
    expect(out.files?.[0]?.description).toBe("[redacted:file-description:msg_user]")
    expect(out.files?.[0]?.source?.text).toBe("[redacted:file-text:msg_user]")
    expect(out.files?.[0]?.mime).toBe("text/plain")
    expect(out.agents?.[0]?.name).toBe("build")
    expect(out.agents?.[0]?.source?.text).toBe("[redacted:agent-source:msg_user]")
    expect(out.metadata).toEqual({ redacted: "message-metadata:msg_user" })
  })

  test("redacts assistant text/reasoning/tool states; keeps tool names and tokens", () => {
    const out = sanitizeMessage(assistant) as SessionMessage.Assistant
    const [text, reasoning, completed, errored] = out.content as [
      SessionMessage.AssistantText,
      SessionMessage.AssistantReasoning,
      SessionMessage.AssistantTool,
      SessionMessage.AssistantTool,
    ]
    expect(text.text).toBe("[redacted:text:txt_1]")
    expect(reasoning.text).toBe("[redacted:reasoning:rsn_1]")
    expect(completed.name).toBe("read")
    expect(completed.state.status).toBe("completed")
    if (completed.state.status === "completed") {
      expect(completed.state.input).toEqual({ redacted: "tool-input:tool_1" })
      expect(completed.state.structured).toEqual({ redacted: "tool-structured:tool_1" })
      expect(completed.state.content[0]).toEqual({ type: "text", text: "[redacted:tool-content:tool_1]" })
      expect(completed.state.content[1]).toMatchObject({ uri: "[redacted:tool-content-uri:tool_1]" })
      expect(completed.state.attachments?.[0]?.uri).toBe("[redacted:tool-attachment-uri:tool_1]")
      expect(completed.state.outputPaths?.[0]).toBe("[redacted:tool-output-path:tool_1-0]")
      expect(completed.state.result).toEqual({ redacted: "tool-result:tool_1" })
    }
    if (errored.state.status === "error") {
      expect(errored.state.input).toEqual({ redacted: "tool-input:tool_2" })
      // An EMPTY structured record is not user content — passes through (the V1 `data()` rule).
      expect(errored.state.structured).toEqual({})
      expect(errored.state.error.message).toBe("[redacted:tool-error:tool_2]")
    }
    expect(out.error?.message).toBe("[redacted:error:msg_assistant]")
    expect(out.tokens).toEqual(assistant.tokens)
    expect(out.model).toEqual(assistant.model)
  })

  test("redacts shell + compaction; leaves switch markers intact", () => {
    const shellOut = sanitizeMessage(shell) as SessionMessage.Shell
    expect(shellOut.command).toBe("[redacted:shell-command:msg_shell]")
    expect(shellOut.output).toBe("[redacted:shell-output:msg_shell]")
    const compactionOut = sanitizeMessage(compaction) as SessionMessage.Compaction
    expect(compactionOut.summary).toBe("[redacted:compaction-summary:msg_compaction]")
    expect(compactionOut.recent).toBe("[redacted:compaction-recent:msg_compaction]")
    const switchedOut = sanitizeMessage(switched) as SessionMessage.AgentSwitched
    expect(switchedOut.agent).toBe("plan")
  })

  test("sanitized output still encodes through the wire schema", () => {
    const encoded = encodeMessages([user, assistant, shell, compaction, switched].map(sanitizeMessage))
    expect(encoded).toHaveLength(5)
    // The wire shape carries millis timestamps and drops undefined optionals.
    expect((encoded[0] as { time: { created: number } }).time.created).toBe(0)
    expect(JSON.stringify(encoded)).not.toContain("secret")
  })
})
