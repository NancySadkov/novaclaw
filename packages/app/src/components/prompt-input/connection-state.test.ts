import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { reconnectingPromptAttempt } from "./connection-state"
import { dict as en } from "@/i18n/en"

describe("the prompt is replaced while its transcript connection is unavailable", () => {
  test("initial connection and every retry expose a human one-based attempt", () => {
    expect(reconnectingPromptAttempt("connecting", 0)).toBe(1)
    expect(reconnectingPromptAttempt("reconnecting", 1)).toBe(1)
    expect(reconnectingPromptAttempt("reconnecting", 7)).toBe(7)
    expect(en["app.connection.promptReconnecting"]).toBe("Connection Lost. Reconnecting Attempt {{attempt}}")
  })

  test("only a connected client exposes the prompt", () => {
    expect(reconnectingPromptAttempt("connected", 0)).toBeUndefined()
    expect(reconnectingPromptAttempt("idle", 0)).toBe(1)
  })

  test("the real composer reads both signals and replaces its form with the numbered status", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "..", "prompt-input.tsx"), "utf8")
    expect(source).toContain("connection.streamStatus(), connection.reconnectAttempt()")
    expect(source).toContain("<PromptConnectionBoundary")
    expect(source).toContain("attempt={reconnectingAttempt()}")
  })
})
