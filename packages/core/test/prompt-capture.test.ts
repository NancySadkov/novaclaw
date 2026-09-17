import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PromptCapture } from "@novaclaw/core/session/prompt-capture"

const message = (role: "user" | "assistant", text: string) => ({ role, content: [{ type: "text", text }] }) as never

describe("PromptCapture", () => {
  test("render keeps the system parts, messages and tools in one readable text", () => {
    const text = PromptCapture.render({
      sessionID: "ses_test",
      at: new Date(0),
      system: [{ type: "text", text: "You are Nova." } as never],
      messages: [message("user", "hello")],
      tools: [{ name: "read" }],
    })
    expect(text).toContain("===== SYSTEM (1) =====")
    expect(text).toContain("You are Nova.")
    expect(text).toContain("[user]:")
    expect(text).toContain("hello")
    expect(text).toContain("===== TOOLS (1) =====")
    expect(text).toContain('"name": "read"')
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
