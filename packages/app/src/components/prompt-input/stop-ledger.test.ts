import { describe, expect, test } from "bun:test"
import { clearStopLedger, pushStopLedger, readStopLedger } from "./stop-ledger"

describe("stop-ledger", () => {
  test("keeps the last 50 presses, oldest first", () => {
    clearStopLedger()
    for (let i = 0; i < 60; i++)
      pushStopLedger({
        sessionID: `ses_${i}`,
        shown: "stop",
        working: true,
        blank: false,
        resuming: false,
        action: "abort",
      })
    const rows = readStopLedger()
    expect(rows).toHaveLength(50)
    expect(rows[0]?.sessionID).toBe("ses_10")
    expect(rows.at(-1)?.sessionID).toBe("ses_59")
  })

  test("stamps each entry and publishes the ring for live diagnosis", () => {
    clearStopLedger()
    const before = Date.now()
    const entry = pushStopLedger({
      sessionID: "ses_x",
      shown: "send",
      working: false,
      blank: true,
      resuming: false,
      action: "submit-path",
    })
    expect(entry.at).toBeGreaterThanOrEqual(before)
    expect(entry.action).toBe("submit-path")
    expect(readStopLedger()).toEqual([entry])
    expect((globalThis as unknown as { __novaStopLedger?: unknown }).__novaStopLedger).toEqual([entry])
  })

  test("read returns a copy — callers cannot rewrite history", () => {
    clearStopLedger()
    pushStopLedger({
      sessionID: undefined,
      shown: "play",
      working: false,
      blank: true,
      resuming: true,
      action: "abort",
    })
    const rows = readStopLedger()
    expect(rows).toHaveLength(1)
    const mutable = [...rows]
    mutable.length = 0
    expect(readStopLedger()).toHaveLength(1)
    clearStopLedger()
    expect(readStopLedger()).toHaveLength(0)
  })
})
