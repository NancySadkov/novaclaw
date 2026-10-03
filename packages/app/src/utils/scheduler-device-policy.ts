// The Debug Scheduler tab edits DEVICE policy: the admission cap, the cache-affinity window and the
// operator's declared locality. These are the scheduler's only live levers — everything else is the
// turn lifecycle the scheduler owns itself — so they are worth exposing beside the queues they move.
//
// The values live in `config.devices`, keyed by device id. A scheduler device key is a declared id
// when one claims the endpoint, and a normalized endpoint ORIGIN otherwise; the second has no config
// entry yet, so editing it NAMES it (an id derived from the origin, with that origin as its
// endpoint) rather than leaving the control inert. Pure and unit-tested; the panel only calls it.

export type DeviceLocality = "local" | "lan" | "remote"

export interface DeviceConfigEntry {
  readonly endpoints?: readonly string[]
  readonly concurrency?: number
  readonly minRunMs?: number
  readonly locality?: DeviceLocality
}

export interface DevicePolicyDraft {
  readonly concurrency: string
  readonly minRunSeconds: string
  readonly locality: "" | DeviceLocality
}

export type DevicePolicyValues =
  | {
      readonly ok: true
      readonly concurrency: number | undefined
      readonly minRunMs: number | undefined
      readonly locality: DeviceLocality | undefined
    }
  | { readonly ok: false; readonly message: string }

export interface DevicePolicyChange {
  readonly deviceID: string
  readonly created: boolean
  /**
   * The whole entry to PATCH — endpoints preserved, cleared fields dropped. A cleared stickiness
   * window is the exception and is written as 0 in here, not dropped: it has to reach the live
   * device, and only an admission carrying the value can do that.
   */
  readonly entry: DeviceConfigEntry
  /** Config paths whose stored override must be DELETED, because blank means "no policy". */
  readonly clear: readonly ("concurrency" | "minRunMs" | "locality")[]
}

const POLICY_FIELDS = ["concurrency", "minRunMs", "locality"] as const

/** A normalized origin, or `undefined` for a per-model key (a hosted model with no endpoint). */
export const endpointOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.origin.toLowerCase() === value.toLowerCase() ? url.origin.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** A stable config id for a device named after its origin. Mirrors the model dialog's convention. */
export const deviceIDForOrigin = (origin: string, devices: Readonly<Record<string, DeviceConfigEntry>>): string => {
  const stem =
    origin
      .replace(/^[a-z]+:\/\//i, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "device"
  if (devices[stem] === undefined) return stem
  for (let suffix = 2; ; suffix++) if (devices[`${stem}-${suffix}`] === undefined) return `${stem}-${suffix}`
}

export const isDevicePolicyEditable = (
  deviceKey: string,
  devices: Readonly<Record<string, DeviceConfigEntry>>,
): boolean => devices[deviceKey] !== undefined || endpointOrigin(deviceKey) !== undefined

export const devicePolicyDraft = (entry: DeviceConfigEntry | undefined): DevicePolicyDraft => ({
  concurrency: entry?.concurrency === undefined ? "" : String(entry.concurrency),
  minRunSeconds: entry?.minRunMs === undefined ? "" : String(Math.round(entry.minRunMs / 1000)),
  locality: entry?.locality ?? "",
})

/** Blank is not zero — it is the ABSENCE of a policy, and the parse says so with `undefined`. */
export const parseDevicePolicy = (draft: DevicePolicyDraft): DevicePolicyValues => {
  const concurrencyText = draft.concurrency.trim()
  let concurrency: number | undefined
  if (concurrencyText !== "") {
    const value = Number(concurrencyText)
    if (!Number.isFinite(value) || value < 1) {
      return { ok: false, message: "Concurrency must be a whole number of 1 or more." }
    }
    concurrency = Math.floor(value)
  }
  const secondsText = draft.minRunSeconds.trim()
  let minRunMs: number | undefined
  if (secondsText !== "") {
    const value = Number(secondsText)
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, message: "Stickiness must be zero or more seconds." }
    }
    minRunMs = Math.round(value * 1000)
  }
  return {
    ok: true,
    concurrency,
    minRunMs,
    locality: draft.locality === "" ? undefined : draft.locality,
  }
}

/**
 * Turn a parsed policy into the config change that applies it. Returns `undefined` when the device
 * has no editable identity — a model with no endpoint keeps a per-model key that no `devices` entry
 * can claim, and pretending otherwise would write a config row the scheduler never reads.
 */
export const devicePolicyChange = (input: {
  readonly deviceKey: string
  readonly devices: Readonly<Record<string, DeviceConfigEntry>>
  readonly values: { readonly concurrency?: number; readonly minRunMs?: number; readonly locality?: DeviceLocality }
}): DevicePolicyChange | undefined => {
  const existing = input.devices[input.deviceKey]
  const origin = endpointOrigin(input.deviceKey)
  const deviceID =
    existing !== undefined
      ? input.deviceKey
      : origin !== undefined
        ? deviceIDForOrigin(origin, input.devices)
        : undefined
  if (deviceID === undefined) return undefined

  // ⚠️ A cleared STICKINESS window is written as 0, not deleted. `syncDevices` only pushes
  // `concurrency` into the live device, so the window rides an admission's profile — and an
  // admission that carries no `minRunMs` leaves the running device's last value in place. 0 is the
  // documented "disabled" spelling and DOES take effect on the next turn, so it is what "clear"
  // means here. Concurrency has no such gap: deleting it resets the live cap to the default.
  const set = {
    ...(input.values.concurrency === undefined ? {} : { concurrency: input.values.concurrency }),
    ...(input.values.minRunMs === undefined
      ? existing?.minRunMs === undefined
        ? {}
        : { minRunMs: 0 }
      : { minRunMs: input.values.minRunMs }),
    ...(input.values.locality === undefined ? {} : { locality: input.values.locality }),
  }
  const entry: DeviceConfigEntry = {
    endpoints: existing?.endpoints ?? (origin === undefined ? [] : [origin]),
    ...set,
  }
  const clear = POLICY_FIELDS.filter(
    (field) =>
      field !== "minRunMs" &&
      (input.values as Record<string, unknown>)[field] === undefined &&
      existing?.[field] !== undefined,
  )
  return { deviceID, created: existing === undefined, entry, clear }
}
