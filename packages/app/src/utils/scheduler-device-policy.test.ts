import { describe, expect, test } from "bun:test"
import {
  deviceIDForOrigin,
  devicePolicyChange,
  devicePolicyDraft,
  isDevicePolicyEditable,
  parseDevicePolicy,
} from "./scheduler-device-policy"

describe("parseDevicePolicy", () => {
  test("blank means no policy, not zero", () => {
    expect(parseDevicePolicy({ concurrency: "", minRunSeconds: "", locality: "" })).toEqual({
      ok: true,
      concurrency: undefined,
      minRunMs: undefined,
      locality: undefined,
    })
  })

  test("seconds are stored as milliseconds, and locality passes through", () => {
    expect(parseDevicePolicy({ concurrency: "3", minRunSeconds: "12", locality: "lan" })).toEqual({
      ok: true,
      concurrency: 3,
      minRunMs: 12_000,
      locality: "lan",
    })
  })

  test("a cap below one is refused with a plain message", () => {
    const parsed = parseDevicePolicy({ concurrency: "0", minRunSeconds: "", locality: "" })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain("1 or more")
  })

  test("a negative stickiness window is refused", () => {
    const parsed = parseDevicePolicy({ concurrency: "", minRunSeconds: "-1", locality: "" })
    expect(parsed.ok).toBe(false)
  })
})

describe("devicePolicyChange", () => {
  test("an existing declared device is patched in place and preserves its endpoints", () => {
    const change = devicePolicyChange({
      deviceKey: "spark",
      devices: { spark: { endpoints: ["http://host:8010"], concurrency: 4 } },
      values: { concurrency: 2 },
    })
    expect(change).toMatchObject({ deviceID: "spark", created: false, clear: [] })
    expect(change!.entry).toEqual({ endpoints: ["http://host:8010"], concurrency: 2 })
  })

  test("a blanked field is listed for DELETION rather than written as a value", () => {
    const change = devicePolicyChange({
      deviceKey: "spark",
      devices: { spark: { endpoints: ["http://host:8010"], concurrency: 4, minRunMs: 5_000 } },
      values: { minRunMs: 9_000 },
    })
    expect(change!.clear).toEqual(["concurrency"])
    expect(change!.entry).toEqual({ endpoints: ["http://host:8010"], minRunMs: 9_000 })
  })

  test("clearing stickiness writes 0 — the live-effective spelling — rather than deleting it", () => {
    const change = devicePolicyChange({
      deviceKey: "spark",
      devices: { spark: { endpoints: ["http://host:8010"], concurrency: 4, minRunMs: 5_000 } },
      values: { concurrency: 4 },
    })
    expect(change!.entry).toEqual({ endpoints: ["http://host:8010"], concurrency: 4, minRunMs: 0 })
    expect(change!.clear).not.toContain("minRunMs")
  })

  test("an undeclared origin gets a named device the scheduler can then key on", () => {
    const change = devicePolicyChange({
      deviceKey: "http://192.168.178.40:8010",
      devices: {},
      values: { concurrency: 1 },
    })
    expect(change).toMatchObject({ deviceID: "192-168-178-40-8010", created: true })
    expect(change!.entry).toEqual({ endpoints: ["http://192.168.178.40:8010"], concurrency: 1 })
  })

  test("a model with no endpoint has no editable device identity", () => {
    expect(
      devicePolicyChange({
        deviceKey: "openai/gpt-5",
        devices: {},
        values: { concurrency: 2 },
      }),
    ).toBeUndefined()
    expect(isDevicePolicyEditable("openai/gpt-5", {})).toBe(false)
    expect(isDevicePolicyEditable("spark", { spark: {} })).toBe(true)
  })

  test("a new device id never collides with a declared one", () => {
    expect(deviceIDForOrigin("http://host:8010", { "host-8010": { endpoints: [] } })).toBe("host-8010-2")
  })

  test("a draft seeds from the stored entry, in seconds", () => {
    expect(devicePolicyDraft({ concurrency: 2, minRunMs: 12_000, locality: "local" })).toEqual({
      concurrency: "2",
      minRunSeconds: "12",
      locality: "local",
    })
  })
})
