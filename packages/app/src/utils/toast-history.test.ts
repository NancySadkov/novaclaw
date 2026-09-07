import { describe, expect, test } from "bun:test"
import { DEFAULT_TOAST_DURATION_MS, resolveToastLifetime } from "./toast"
import { flushToastHistory, recordToastHistory, subscribeToastHistory } from "./toast-history"

describe("toast lifetime and history", () => {
  test("ordinary notifications fade while loading and explicit persistent notices remain", () => {
    expect(resolveToastLifetime({})).toEqual({ duration: DEFAULT_TOAST_DURATION_MS, persistent: false })
    expect(resolveToastLifetime({ variant: "error" })).toEqual({
      duration: DEFAULT_TOAST_DURATION_MS,
      persistent: false,
    })
    expect(resolveToastLifetime({ variant: "loading" })).toEqual({
      duration: DEFAULT_TOAST_DURATION_MS,
      persistent: true,
    })
    expect(resolveToastLifetime({ persistent: true, duration: 123 })).toEqual({ duration: 123, persistent: true })
  })

  test("notices raised before the durable ledger mounts are replayed once", () => {
    const entry = { title: "Saved", variant: "success" as const, time: 123 }
    recordToastHistory(entry)
    const first: unknown[] = []
    const unsubscribe = subscribeToastHistory((item) => {
      first.push(item)
      return true
    })
    expect(first).toEqual([entry])
    unsubscribe()

    const second: unknown[] = []
    const unsubscribeSecond = subscribeToastHistory((item) => {
      second.push(item)
      return true
    })
    expect(second).toEqual([])
    unsubscribeSecond()
  })

  test("a notice waits until the persisted ledger is ready", () => {
    let ready = false
    const received: unknown[] = []
    const unsubscribe = subscribeToastHistory((item) => {
      if (!ready) return false
      received.push(item)
      return true
    })
    const entry = { description: "Waiting", variant: "default" as const, time: 456 }
    recordToastHistory(entry)
    expect(received).toEqual([])
    ready = true
    flushToastHistory()
    expect(received).toEqual([entry])
    unsubscribe()
  })
})
