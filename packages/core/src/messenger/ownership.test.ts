import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MessengerOwnership } from "./ownership"

describe("messenger account ownership", () => {
  const belongsTo = (agentID: string, sessionID: string, rows: Record<string, MessengerOwnership.SessionRecord>) =>
    Effect.runSync(MessengerOwnership.belongsTo(agentID, sessionID, (id) => Effect.succeed(rows[id])))

  test("a child belongs to its root officer", () => {
    const rows = { root: { agent: "apollo" }, child: { parentID: "root", agent: "worker" } }
    expect(belongsTo("apollo", "child", rows)).toBe(true)
    expect(belongsTo("worker", "child", rows)).toBe(false)
  })

  test("an undeclared root belongs to Nova", () => {
    const rows = { root: { agent: null }, child: { parentID: "root" } }
    expect(belongsTo("nova", "child", rows)).toBe(true)
    expect(belongsTo("apollo", "child", rows)).toBe(false)
  })

  test("missing and cyclic chains fail closed", () => {
    expect(belongsTo("nova", "missing", {})).toBe(false)
    expect(belongsTo("nova", "a", { a: { parentID: "b" }, b: { parentID: "a" } })).toBe(false)
  })
})
