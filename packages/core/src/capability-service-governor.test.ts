import { describe, expect, test } from "bun:test"
import { ConfigCapabilityService } from "./config/capability-service"
import { CapabilityServiceGovernor } from "./capability-service-governor"

const service = (over: Partial<ConfigCapabilityService.Info> = {}) =>
  new ConfigCapabilityService.Info({
    capabilities: ["document.parse.layout"],
    transport: new ConfigCapabilityService.HttpTransport({
      type: "streamable-http",
      url: "http://127.0.0.1:9010/mcp",
    }),
    locality: "local",
    resources: new ConfigCapabilityService.Resources({
      estimated_resident_bytes: 100,
      estimated_peak_bytes: 200,
    }),
    idle_timeout_ms: 1_000,
    ...over,
  })

const roomy = { limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }

describe("capability service governor admission", () => {
  test("demand-loads only when the projected peak stays above the hard floor", () => {
    const governor = CapabilityServiceGovernor.make()
    const services = { parser: service() }
    expect(governor.request({ services, serviceID: "parser", requestID: "r1", capacity: roomy, nowMs: 0 })).toEqual({
      kind: "start",
      requestID: "r1",
    })
    expect(governor.loaded("parser")).toEqual({ kind: "run", requestID: "r1" })
  })

  test("unknown or insufficient headroom queues instead of gambling on host OOM", () => {
    const services = { parser: service() }
    const unknown = CapabilityServiceGovernor.make()
    expect(unknown.request({ services, serviceID: "parser", requestID: "r1", nowMs: 0 })).toEqual({
      kind: "queued",
      position: 1,
      unload: [],
    })
    const full = CapabilityServiceGovernor.make()
    expect(
      full.request({
        services,
        serviceID: "parser",
        requestID: "r1",
        capacity: { ...roomy, usedBytes: 700 },
        nowMs: 0,
      }),
    ).toEqual({ kind: "queued", position: 1, unload: [] })
  })

  test("unloads the oldest idle service before a queued start can cross the floor", () => {
    const governor = CapabilityServiceGovernor.make()
    const services = { old: service(), newer: service(), target: service() }
    for (const [id, nowMs] of [["old", 1], ["newer", 2]] as const) {
      expect(governor.request({ services, serviceID: id, requestID: `${id}-run`, capacity: roomy, nowMs }).kind).toBe(
        "start",
      )
      governor.loaded(id)
      governor.completed(id, nowMs)
    }
    expect(
      governor.request({
        services,
        serviceID: "target",
        requestID: "target-run",
        capacity: { ...roomy, usedBytes: 650 },
        nowMs: 3,
      }),
    ).toEqual({ kind: "queued", position: 1, unload: ["old"] })
    expect(governor.snapshot().find((entry) => entry.serviceID === "old")?.phase).toBe("unloading")
  })

  test("bounds the queue and keeps duplicate request admission idempotent", () => {
    const governor = CapabilityServiceGovernor.make()
    const services = { parser: service({ queue_limit: 1 }) }
    const first = governor.request({ services, serviceID: "parser", requestID: "r1", nowMs: 0 })
    expect(first).toEqual({ kind: "queued", position: 1, unload: [] })
    expect(governor.request({ services, serviceID: "parser", requestID: "r1", nowMs: 0 })).toEqual(first)
    expect(governor.request({ services, serviceID: "parser", requestID: "r2", nowMs: 0 })).toEqual({
      kind: "refused",
      reason: "queue-full",
    })
  })

  test("a full target queue never evicts another unrelated idle service", () => {
    const governor = CapabilityServiceGovernor.make()
    const services = { firstIdle: service(), secondIdle: service(), target: service({ queue_limit: 1 }) }
    for (const [id, nowMs] of [["firstIdle", 0], ["secondIdle", 1]] as const) {
      governor.request({ services, serviceID: id, requestID: `${id}-run`, capacity: roomy, nowMs })
      governor.loaded(id)
      governor.completed(id, nowMs)
    }
    const pressured = { ...roomy, usedBytes: 700 }
    governor.request({ services, serviceID: "target", requestID: "first", capacity: pressured, nowMs: 2 })
    expect(governor.request({ services, serviceID: "target", requestID: "second", capacity: pressured, nowMs: 3 })).toEqual({
      kind: "refused",
      reason: "queue-full",
    })
    // The first queued request legitimately selected one victim; the refused second request selected no more.
    expect(governor.snapshot().filter((entry) => entry.phase === "unloading").map((entry) => entry.serviceID)).toEqual([
      "firstIdle",
    ])
    expect(governor.snapshot().find((entry) => entry.serviceID === "secondIdle")?.phase).toBe("ready")
  })
})

describe("capability service governor lifecycle", () => {
  test("serializes work and returns to a warm idle state", () => {
    const governor = CapabilityServiceGovernor.make()
    const services = { parser: service() }
    governor.request({ services, serviceID: "parser", requestID: "r1", capacity: roomy, nowMs: 0 })
    governor.request({ services, serviceID: "parser", requestID: "r2", capacity: roomy, nowMs: 1 })
    governor.loaded("parser")
    expect(governor.completed("parser", 2)).toEqual({ kind: "idle" })
    expect(governor.poll({ services, serviceID: "parser", capacity: roomy, nowMs: 3 })).toEqual({
      kind: "run",
      requestID: "r2",
    })
    expect(governor.completed("parser", 4)).toEqual({ kind: "idle" })
    expect(governor.snapshot()[0]).toMatchObject({ phase: "ready", queuedRequestIDs: [], lastUsedMs: 4 })
  })

  test("cancellation stops an active load and removes queued work without stopping its neighbor", () => {
    const governor = CapabilityServiceGovernor.make()
    const services = { parser: service() }
    governor.request({ services, serviceID: "parser", requestID: "active", capacity: roomy, nowMs: 0 })
    governor.request({ services, serviceID: "parser", requestID: "queued", capacity: roomy, nowMs: 1 })
    expect(governor.cancel("parser", "queued")).toEqual({ kind: "idle" })
    expect(governor.cancel("parser", "active")).toEqual({ kind: "stop", serviceID: "parser" })
    expect(governor.snapshot()[0]).toMatchObject({ phase: "unloading", queuedRequestIDs: [] })
  })

  test("idle timeout requests unload, while busy services remain protected", () => {
    const governor = CapabilityServiceGovernor.make()
    const services = { idle: service(), busy: service() }
    governor.request({ services, serviceID: "idle", requestID: "i", capacity: roomy, nowMs: 0 })
    governor.loaded("idle")
    governor.completed("idle", 10)
    governor.request({ services, serviceID: "busy", requestID: "b", capacity: roomy, nowMs: 0 })
    governor.loaded("busy")
    expect(governor.sweep(services, 1_010)).toEqual(["idle"])
    expect(governor.snapshot().find((entry) => entry.serviceID === "busy")?.phase).toBe("busy")
  })

  test("a crash fails every affected request and retry re-arms only the named service", () => {
    const governor = CapabilityServiceGovernor.make()
    const services = { parser: service() }
    governor.request({ services, serviceID: "parser", requestID: "active", capacity: roomy, nowMs: 0 })
    governor.request({ services, serviceID: "parser", requestID: "queued", capacity: roomy, nowMs: 1 })
    expect(governor.failed("parser", "worker exited")).toEqual(["active", "queued"])
    expect(governor.request({ services, serviceID: "parser", requestID: "later", capacity: roomy, nowMs: 2 })).toEqual({
      kind: "refused",
      reason: "unavailable",
    })
    expect(governor.retry("parser")).toBe(true)
    expect(governor.request({ services, serviceID: "parser", requestID: "later", capacity: roomy, nowMs: 3 }).kind).toBe(
      "start",
    )
  })

  test("pressure recovery re-admits the oldest queued request against fresh headroom", () => {
    const governor = CapabilityServiceGovernor.make()
    const services = { parser: service() }
    governor.request({
      services,
      serviceID: "parser",
      requestID: "waiting",
      capacity: { ...roomy, usedBytes: 700 },
      nowMs: 0,
    })
    expect(governor.poll({ services, serviceID: "parser", capacity: roomy, nowMs: 1 })).toEqual({
      kind: "start",
      requestID: "waiting",
    })
  })
})
