import { describe, expect, test } from "bun:test"
import { ProviderRecovery } from "./provider-recovery"

const primary = { providerID: "spark", id: "qwen" }

describe("durable provider recovery", () => {
  test("backs off forever from two seconds to ten minutes and resets on success", () => {
    let state: ProviderRecovery.State = {}
    let at = 1_000
    for (let failures = 1; failures <= 12; failures++) {
      state = ProviderRecovery.failed(state, primary, at)
      expect(state[ProviderRecovery.key(primary)]?.failures).toBe(failures)
      expect(state[ProviderRecovery.key(primary)]?.next).toBe(at + ProviderRecovery.delayMs(failures))
      at += ProviderRecovery.delayMs(failures)
    }
    expect(ProviderRecovery.delayMs(1)).toBe(2_000)
    expect(ProviderRecovery.delayMs(2)).toBe(4_000)
    expect(ProviderRecovery.delayMs(99)).toBe(10 * 60_000)
    expect(ProviderRecovery.succeeded(state, primary)).toEqual({})
    expect(ProviderRecovery.failed({}, primary, at)[ProviderRecovery.key(primary)]?.next).toBe(at + 2_000)
  })

  test("routes during backoff and permits a reconnect probe when the deadline arrives", () => {
    const state = ProviderRecovery.failed({}, primary, 10_000)
    expect(ProviderRecovery.unavailable(state, primary, 11_999)).toBe(true)
    expect(ProviderRecovery.unavailable(state, primary, 12_000)).toBe(false)
  })

  test("counts the one quick reconnect before switching to single recovery probes", () => {
    const exhausted = ProviderRecovery.exhausted({}, primary, 10_000)
    expect(exhausted[ProviderRecovery.key(primary)]).toEqual({ failures: 2, next: 14_000 })
    expect(ProviderRecovery.exhausted(exhausted, primary, 14_000)[ProviderRecovery.key(primary)]).toEqual({
      failures: 3,
      next: 22_000,
    })
  })

  test("a substitute must cover tools and every input/output modality", () => {
    const required = { tools: true, input: ["text", "image"], output: ["text"] }
    expect(
      ProviderRecovery.capabilitiesMatch(required, {
        tools: true,
        input: ["text", "image", "audio"],
        output: ["text"],
      }),
    ).toBe(true)
    expect(
      ProviderRecovery.capabilitiesMatch(required, { tools: false, input: ["text", "image"], output: ["text"] }),
    ).toBe(false)
    expect(ProviderRecovery.capabilitiesMatch(required, { tools: true, input: ["text"], output: ["text"] })).toBe(false)
  })

  test("chooses the earliest recovery probe when every compatible route is down", () => {
    const first = { providerID: "local", id: "first" }
    const second = { providerID: "local", id: "second" }
    const state = {
      "local/first": { failures: 3, next: 8_000 },
      "local/second": { failures: 2, next: 4_000 },
    }
    expect(ProviderRecovery.earliest(state, [first, second])).toEqual({ model: second, next: 4_000 })
    expect(ProviderRecovery.earliest({}, [first])).toBeUndefined()
  })
})
