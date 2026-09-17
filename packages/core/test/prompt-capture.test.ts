import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PromptCapture } from "@novaclaw/core/session/prompt-capture"

const message = (role: "user" | "assistant", text: string) => ({ role, content: [{ type: "text", text }] }) as never

describe("PromptCapture", () => {
  test("render is the request JSON with nothing added", () => {
    const text = PromptCapture.render({
      system: [{ type: "text", text: "You are Nova." } as never],
      messages: [message("user", "hello")],
      tools: [{ name: "read" }],
    })
    expect(text.startsWith('{"system":')).toBe(true)
    expect(text).not.toContain("=====")
    const parsed = JSON.parse(text)
    expect(parsed.system[0].text).toBe("You are Nova.")
    expect(parsed.messages[0].content[0].text).toBe("hello")
    expect(parsed.tools[0].name).toBe("read")
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
