import { describe, expect, test } from "bun:test"
import * as Reference from "@novaclaw/core/kb-graph/reference"

describe("model-facing KB references", () => {
  test("handles resolve only in their issuing session and never expose the storage id", () => {
    const store = Reference.make()
    const handle = store.issue("ses_one", "clm_private_claim_123")

    expect(Reference.isHandle(handle)).toBe(true)
    expect(handle).toMatch(/^ref_[A-Za-z0-9_-]+$/)
    expect(handle).not.toContain("clm_private_claim_123")
    expect(store.resolve("ses_one", handle)).toBe("clm_private_claim_123")
    expect(store.resolve("ses_two", handle)).toBeUndefined()
    expect(store.resolve("ses_one", "clm_private_claim_123")).toBeUndefined()
  })

  test("bounds per-session and total-session state by evicting the oldest handles", () => {
    const store = Reference.make({ maxHandlesPerSession: 2, maxSessions: 2 })
    const first = store.issue("ses_one", "mem_first")
    const second = store.issue("ses_one", "mem_second")
    const third = store.issue("ses_one", "mem_third")

    expect(store.resolve("ses_one", first)).toBeUndefined()
    expect(store.resolve("ses_one", second)).toBe("mem_second")
    expect(store.resolve("ses_one", third)).toBe("mem_third")
    expect(store.sessionSize("ses_one")).toBe(2)

    store.issue("ses_two", "mem_other")
    store.issue("ses_three", "mem_newest")
    expect(store.sessionSize("ses_one")).toBe(0)
    expect(store.size()).toBe(2)
  })

  test("forgetSession expires all of a session's handles", () => {
    const store = Reference.make()
    const handle = store.issue("ses_one", "mem_one")
    store.issue("ses_two", "mem_two")

    store.forgetSession("ses_one")
    expect(store.resolve("ses_one", handle)).toBeUndefined()
    expect(store.size()).toBe(1)
  })
})
