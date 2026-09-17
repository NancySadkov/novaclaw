import { afterEach, describe, expect, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/sdk/v2/client"
import {
  downloadPlainText,
  serializeContextSegment,
  serializeSessionTranscript,
  sessionExportFilename,
  wireSystemPrompt,
} from "./session-context-export"

const messages = [
  { id: "system-1", type: "system", text: "stand tall", time: { created: 1 } },
  { id: "user-1", type: "user", text: "hello", time: { created: 2 } },
  {
    id: "assistant-1",
    type: "assistant",
    agent: "nova",
    model: { providerID: "local", id: "small" },
    content: [
      { id: "text-1", type: "text", text: "Hi" },
      { id: "reasoning-1", type: "reasoning", text: "Think" },
      { id: "tool-1", type: "tool", tool: "read", state: { status: "pending", input: "{}" } },
    ],
    time: { created: 3 },
  },
] as unknown as SessionMessage[]

const nativeCreateObjectURL = URL.createObjectURL
const nativeRevokeObjectURL = URL.revokeObjectURL
const nativeAnchorClick = HTMLAnchorElement.prototype.click

afterEach(() => {
  URL.createObjectURL = nativeCreateObjectURL
  URL.revokeObjectURL = nativeRevokeObjectURL
  HTMLAnchorElement.prototype.click = nativeAnchorClick
  document.body.innerHTML = ""
})

describe("session context exports", () => {
  test("exports the complete native transcript as text", () => {
    const output = serializeSessionTranscript(messages)
    expect(output).toContain('"id": "system-1"')
    expect(output).toContain('"id": "user-1"')
    expect(output).toContain('"id": "assistant-1"')
  })

  test("keeps prose and tool payloads in their own segment exports", () => {
    const assistant = serializeContextSegment({ key: "assistant", messages, estimatedTokens: 2 })
    const tool = serializeContextSegment({ key: "tool", messages, estimatedTokens: 1 })

    expect(assistant).toContain('"id": "text-1"')
    expect(assistant).toContain('"id": "reasoning-1"')
    expect(assistant).not.toContain('"id": "tool-1"')
    expect(tool).toContain('"id": "tool-1"')
    expect(tool).not.toContain('"id": "text-1"')
  })

  test("exports provider overhead honestly when no raw message owns it", () => {
    const output = serializeContextSegment({ key: "other", messages, estimatedTokens: 842 })
    expect(output).toContain('"estimatedTokens": 842')
    expect(output).toContain("not represented by a native session message")
  })

  test("reads the sent system prompt out of the captured wire body", () => {
    // What Context Inspect shows and Export Prompt downloads must be the `role: "system"` content of
    // the exact body captured at dispatch — the same bytes a `curl` would replay.
    const body = JSON.stringify({
      model: "local-model",
      messages: [
        { role: "system", content: "You're officer agent of a NovaClaw instance." },
        { role: "user", content: "hello" },
      ],
      stream: true,
    })
    expect(wireSystemPrompt(body)).toBe("You're officer agent of a NovaClaw instance.")
    // Multimodal content and whitespace-only content are both handled without throwing.
    expect(wireSystemPrompt(JSON.stringify({ messages: [{ role: "system", content: [{ type: "text", text: "hi" }] }] })))
      .toBe("hi")
    expect(wireSystemPrompt(JSON.stringify({ messages: [{ role: "system", content: "   " }] }))).toBeUndefined()
    // Not OpenAI-shaped, or not JSON: fall back rather than crash the tab.
    expect(wireSystemPrompt(JSON.stringify({ system: "anthropic-style" }))).toBeUndefined()
    expect(wireSystemPrompt("not json")).toBeUndefined()
  })

  test("creates portable text filenames", () => {
    expect(sessionExportFilename("Nóva / Research", "transcript")).toBe("nova-research-transcript.txt")
    expect(sessionExportFilename("???", "system-context")).toBe("session-system-context.txt")
  })

  test("downloads a text blob under the requested filename", () => {
    let blob: Blob | MediaSource | undefined
    let clicked: { href: string; download: string } | undefined
    URL.createObjectURL = (value) => {
      blob = value
      return "blob:context-export"
    }
    URL.revokeObjectURL = () => {}
    HTMLAnchorElement.prototype.click = function () {
      clicked = { href: this.href, download: this.download }
    }

    downloadPlainText("nova-transcript.txt", "raw session log")

    expect(clicked).toEqual({ href: "blob:context-export", download: "nova-transcript.txt" })
    expect(blob instanceof Blob ? blob.type : undefined).toBe("text/plain;charset=utf-8")
    expect(document.querySelector("a")).toBeNull()
  })
})
