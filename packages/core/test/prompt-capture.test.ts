import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PromptCapture } from "@novaclaw/core/session/prompt-capture"

describe("PromptCapture", () => {
  test("capture writes the text verbatim, adding nothing", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-capture-"))
    const wire = JSON.stringify({ model: "holo3.1", messages: [{ role: "user", content: "hello" }], stream: true })
    await PromptCapture.capture({ scratchFolder: scratch, sessionID: "ses_wire", text: wire })
    const read = await PromptCapture.read({ scratchFolder: scratch, sessionID: "ses_wire" })
    // Byte-identical, and still valid JSON — the export is the provider body, not a dump around it.
    expect(read.latest).toBe(wire)
    expect(read.initial).toBe(wire)
    expect(read.latest).not.toContain("=====")
    expect(JSON.parse(read.latest!).messages[0].content).toBe("hello")
  })

  test("capture replaces latest every turn and keeps the first turn as the init prompt", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-capture-"))
    await PromptCapture.capture({ scratchFolder: scratch, sessionID: "ses_test", text: "FIRST" })
    await PromptCapture.capture({ scratchFolder: scratch, sessionID: "ses_test", text: "SECOND" })
    const read = await PromptCapture.read({ scratchFolder: scratch, sessionID: "ses_test" })
    expect(read.initial).toBe("FIRST")
    expect(read.latest).toBe("SECOND")
  })

  test("read reports nothing before any capture", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-capture-"))
    expect(await PromptCapture.read({ scratchFolder: scratch, sessionID: "ses_none" })).toEqual({})
  })
})
