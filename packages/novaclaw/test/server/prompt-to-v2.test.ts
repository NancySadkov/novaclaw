import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { PromptInput } from "@novaclaw/schema/prompt-input"
import { toV2Prompt } from "../../src/server/routes/instance/httpapi/handlers/session"
import { PromptPayload } from "../../src/server/routes/instance/httpapi/groups/session"

// Build a PromptPayload from a parts array (the only field toV2Prompt reads
// besides text). We decode through the real PromptPayload schema so the input
// is exactly what the wire produces.
function payload(parts: unknown[]): typeof PromptPayload.Type {
  return Schema.decodeUnknownSync(PromptPayload)({ parts })
}

const decodePrompt = Schema.decodeUnknownSync(PromptInput.Prompt)

describe("toV2Prompt", () => {
  test("text-only part → { text }", () => {
    const out = toV2Prompt(payload([{ type: "text", text: "hello" }]))
    expect(out).toEqual({ text: "hello" })
    // decodes as a valid PromptInput.Prompt (no mime required anywhere)
    expect(decodePrompt(out)).toEqual({ text: "hello" })
  })

  test("multiple text parts are newline-joined", () => {
    const out = toV2Prompt(payload([
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ]))
    expect(out.text).toBe("line one\nline two")
    expect(out.files).toBeUndefined()
    expect(out.agents).toBeUndefined()
  })

  test("file part → { uri, name } with NO mime", () => {
    const out = toV2Prompt(payload([
      { type: "text", text: "see file" },
      { type: "file", mime: "text/plain", url: "file:///a.txt", filename: "a.txt" },
    ]))
    expect(out.text).toBe("see file")
    expect(out.files).toEqual([{ uri: "file:///a.txt", name: "a.txt" }])
    // critical: the V2 FileAttachment has no mime — the result must still decode
    const decoded = decodePrompt(out)
    expect(decoded.files?.[0]).toEqual({ uri: "file:///a.txt", name: "a.txt" })
    expect("mime" in (decoded.files![0] as object)).toBe(false)
  })

  test("file part without filename → { uri } only", () => {
    const out = toV2Prompt(payload([{ type: "file", mime: "image/png", url: "https://x/y.png" }]))
    expect(out.files).toEqual([{ uri: "https://x/y.png" }])
    expect(decodePrompt(out).files).toEqual([{ uri: "https://x/y.png" }])
  })

  test("agent part → { name }", () => {
    const out = toV2Prompt(payload([
      { type: "text", text: "do it" },
      { type: "agent", name: "build" },
    ]))
    expect(out.agents).toEqual([{ name: "build" }])
    expect(decodePrompt(out).agents).toEqual([{ name: "build" }])
  })

  test("subtask part is dropped", () => {
    const out = toV2Prompt(payload([
      { type: "text", text: "go" },
      { type: "subtask", prompt: "sub", description: "d", agent: "build" },
    ]))
    expect(out).toEqual({ text: "go" })
  })

  test("empty parts → { text: '' }", () => {
    const out = toV2Prompt(payload([]))
    expect(out).toEqual({ text: "" })
    expect(decodePrompt(out)).toEqual({ text: "" })
  })

  test("mixed text + file + agent, all carried", () => {
    const out = toV2Prompt(payload([
      { type: "text", text: "a" },
      { type: "file", mime: "text/plain", url: "u", filename: "f" },
      { type: "agent", name: "build" },
      { type: "text", text: "b" },
      { type: "subtask", prompt: "p", description: "d", agent: "build" },
    ]))
    expect(out.text).toBe("a\nb")
    expect(out.files).toEqual([{ uri: "u", name: "f" }])
    expect(out.agents).toEqual([{ name: "build" }])
    expect(decodePrompt(out)).toBeDefined()
  })

  // F1e S5: the composer's inline @-mention span must survive the wire so the native
  // user message stays faithful (fork/undo/command reconstruct the Prompt from it).
  test("file part with source → carries {start,end,text}", () => {
    const out = toV2Prompt(payload([
      { type: "text", text: "look at @src/a.ts" },
      {
        type: "file",
        mime: "text/plain",
        url: "file:///repo/src/a.ts",
        filename: "a.ts",
        source: { type: "file", path: "/repo/src/a.ts", text: { value: "@src/a.ts", start: 8, end: 17 } },
      },
    ]))
    expect(out.files).toEqual([
      { uri: "file:///repo/src/a.ts", name: "a.ts", source: { start: 8, end: 17, text: "@src/a.ts" } },
    ])
    expect(decodePrompt(out).files?.[0]?.source).toEqual({ start: 8, end: 17, text: "@src/a.ts" })
  })

  test("agent part with source → carries {start,end,text}", () => {
    const out = toV2Prompt(payload([
      { type: "text", text: "ask @build please" },
      { type: "agent", name: "build", source: { value: "@build", start: 4, end: 10 } },
    ]))
    expect(out.agents).toEqual([{ name: "build", source: { start: 4, end: 10, text: "@build" } }])
    expect(decodePrompt(out).agents?.[0]?.source).toEqual({ start: 4, end: 10, text: "@build" })
  })

  test("file/agent parts without source omit it (no empty source key)", () => {
    const out = toV2Prompt(payload([
      { type: "file", mime: "text/plain", url: "u", filename: "f" },
      { type: "agent", name: "build" },
    ]))
    expect("source" in (out.files![0] as object)).toBe(false)
    expect("source" in (out.agents![0] as object)).toBe(false)
  })
})
