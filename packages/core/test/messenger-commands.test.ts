import { describe, expect, test } from "bun:test"
import { MessengerCommands } from "@novaclaw/core/messenger/commands"

// P0 gate (notes/messenger-plan.md §8): the gateway command parser is deterministic and closed —
// plain chat text is NEVER a command, and the Telegram group form `/cmd@BotName` normalizes.

describe("MessengerCommands.parse", () => {
  test("plain text is not a command", () => {
    expect(MessengerCommands.parse("hello there")).toBeUndefined()
    expect(MessengerCommands.parse("look at /tmp/file")).toBeUndefined()
    expect(MessengerCommands.parse("/ spaced slash")).toBeUndefined()
    expect(MessengerCommands.parse("/2fa starts with a digit")).toBeUndefined()
    expect(MessengerCommands.parse("")).toBeUndefined()
  })

  test("pair carries its code, including an empty one for the gateway to reject", () => {
    expect(MessengerCommands.parse("/pair 481-263")).toEqual({ kind: "pair", code: "481-263" })
    expect(MessengerCommands.parse("/pair")).toEqual({ kind: "pair", code: "" })
  })

  test("telegram group mentions and case normalize", () => {
    expect(MessengerCommands.parse("/PAIR@NovaBot 123")).toEqual({ kind: "pair", code: "123" })
    expect(MessengerCommands.parse("  /sessions@NovaBot  ")).toEqual({ kind: "sessions" })
  })

  test("new takes an optional agent", () => {
    expect(MessengerCommands.parse("/new")).toEqual({ kind: "new" })
    expect(MessengerCommands.parse("/new build")).toEqual({ kind: "new", agent: "build" })
  })

  test("use requires a positive integer", () => {
    expect(MessengerCommands.parse("/use 2")).toEqual({ kind: "use", index: 2 })
    expect(MessengerCommands.parse("/use nope")).toEqual({ kind: "unknown", name: "use" })
    expect(MessengerCommands.parse("/use 0")).toEqual({ kind: "unknown", name: "use" })
  })

  test("start reads as help; unknown names are surfaced, not swallowed", () => {
    expect(MessengerCommands.parse("/start")).toEqual({ kind: "help" })
    expect(MessengerCommands.parse("/help")).toEqual({ kind: "help" })
    expect(MessengerCommands.parse("/stop")).toEqual({ kind: "stop" })
    expect(MessengerCommands.parse("/status")).toEqual({ kind: "status" })
    expect(MessengerCommands.parse("/frobnicate now")).toEqual({ kind: "unknown", name: "frobnicate" })
  })
})
