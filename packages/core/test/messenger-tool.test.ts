import { describe, expect, test } from "bun:test"
import { MessengerTool } from "@novaclaw/core/tool/messenger"

// The `messenger` tool's pure helpers (notes/messenger-plan.md §4). buildModerationAct maps the flat
// op the model emits onto the driver ModerationAct union, validating that each act carries the target
// it needs (delete/pin → a message id; ban/kick/mute → a user id) with a legible error otherwise.

describe("MessengerTool.buildModerationAct", () => {
  test("delete and pin require a message id", () => {
    expect(MessengerTool.buildModerationAct({ act: "delete", message: "m1" })).toEqual({ act: "delete", messageID: "m1" })
    expect(MessengerTool.buildModerationAct({ act: "pin", message: "m2" })).toEqual({ act: "pin", messageID: "m2" })
    expect(MessengerTool.buildModerationAct({ act: "delete" })).toEqual({ error: expect.stringContaining("message id") })
    expect(MessengerTool.buildModerationAct({ act: "pin", message: "  " })).toEqual({ error: expect.stringContaining("message id") })
  })

  test("ban, kick, and mute require a user id; mute carries an optional seconds", () => {
    expect(MessengerTool.buildModerationAct({ act: "ban", user: "u9" })).toEqual({ act: "ban", userID: "u9" })
    expect(MessengerTool.buildModerationAct({ act: "kick", user: "u8" })).toEqual({ act: "kick", userID: "u8" })
    expect(MessengerTool.buildModerationAct({ act: "mute", user: "u7", seconds: 300 })).toEqual({ act: "mute", userID: "u7", seconds: 300 })
    expect(MessengerTool.buildModerationAct({ act: "mute", user: "u7" })).toEqual({ act: "mute", userID: "u7" })
    expect(MessengerTool.buildModerationAct({ act: "ban" })).toEqual({ error: expect.stringContaining("user id") })
    // A fractional seconds floors to a whole second.
    expect(MessengerTool.buildModerationAct({ act: "mute", user: "u7", seconds: 90.7 })).toEqual({ act: "mute", userID: "u7", seconds: 90 })
  })

  // Queue moderation (Reddit): approve puts a removed item back; lock closes the chat the op
  // already names, so it asks for no ids at all.
  test("approve needs the item; lock targets the chat and needs nothing", () => {
    expect(MessengerTool.buildModerationAct({ act: "approve", message: "t1_x" })).toEqual({ act: "approve", messageID: "t1_x" })
    expect(MessengerTool.buildModerationAct({ act: "approve" })).toEqual({ error: expect.stringContaining("message id") })
    expect(MessengerTool.buildModerationAct({ act: "lock" })).toEqual({ act: "lock" })
  })

  // On a spam wave, banning the account while its posts stay up leaves the cleanup to a human —
  // `seconds` on a ban is the purge window (Discord deletes that member's recent messages).
  test("ban with seconds purges that member's recent messages", () => {
    expect(MessengerTool.buildModerationAct({ act: "ban", user: "spammer", seconds: 3600 })).toEqual({
      act: "ban",
      userID: "spammer",
      purgeSeconds: 3600,
    })
    expect(MessengerTool.buildModerationAct({ act: "ban", user: "spammer", seconds: -5 })).toEqual({
      act: "ban",
      userID: "spammer",
      purgeSeconds: 0,
    })
  })
})
