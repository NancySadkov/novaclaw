import type { ServerConnection } from "@/context/server"
import type { LocalModelStatus } from "./fs-api"
import { instanceFetch } from "./instance-fetch"

export interface ResourceUsageItem {
  readonly id: string
  readonly label: string
  readonly bytes?: number
  readonly state?: string
  readonly detail?: string
  readonly path?: string
}

export type ResourceLevel = "ok" | "warning" | "floor" | "unknown"

export interface InstanceResources {
  readonly measuredAt: number
  /** The worst verdict across every probe — memory AND disks. */
  readonly level: ResourceLevel
  /** Memory's own verdict. Use this, not `level`, to describe memory: `level` may be a disk's. */
  readonly memoryLevel: ResourceLevel
  readonly memory:
    | { readonly known: true; readonly usedBytes: number; readonly limitBytes: number; readonly crosscheck: string }
    | { readonly known: false; readonly reason: string }
  readonly disks: ReadonlyArray<
    | { readonly known: true; readonly path: string; readonly freeBytes: number; readonly totalBytes: number }
    | { readonly known: false; readonly path: string; readonly reason: string }
  >
  readonly ram: readonly ResourceUsageItem[]
  readonly disk: readonly ResourceUsageItem[]
  readonly localModel: LocalModelStatus
}

export interface InstancePressure {
  readonly measuredAt: number
  readonly level: ResourceLevel
  readonly memoryLevel: ResourceLevel
  readonly memory:
    | { readonly known: true; readonly usedBytes: number; readonly limitBytes: number; readonly crosscheck: string }
    | { readonly known: false; readonly reason: string }
}

export function instancePressure(server: ServerConnection.HttpBase, signal?: AbortSignal) {
  return instanceFetch<InstancePressure>(server, { route: "api/instance/pressure", signal, timeoutMs: 20_000 })
}

export function instanceResources(server: ServerConnection.HttpBase, signal?: AbortSignal) {
  return instanceFetch<InstanceResources>(server, { route: "global/resources", signal, timeoutMs: 20_000 })
}

/**
 * Nova Health — one composed answer to *"is anything wrong?"*.
 *
 * ⚠️ `unknown` is a real verdict, not a missing value, and the UI must never render it as a tick.
 * Some rows can legitimately answer "cannot tell", and dressing an unread probe as healthy is a false report on the one screen a
 * person opens when they already suspect something is broken.
 *
 * ⚠️ `label`/`detail`/`action` arrive as ENGLISH from the server, so this board is not localized the
 * way the rest of Settings is. That is a real gap, recorded rather than hidden: localizing it needs
 * the server to emit keys plus arguments instead of sentences, which is a change to `NovaHealth`'s
 * shape, not to this call.
 */
export type DiagnosisStatus = "problem" | "warning" | "unknown" | "ok"

export interface DiagnosisSignal {
  readonly id: string
  readonly label: string
  readonly status: DiagnosisStatus
  readonly detail?: string
  readonly action?: string
}

export interface Diagnosis {
  readonly overall: DiagnosisStatus
  readonly headline: string
  readonly signals: readonly DiagnosisSignal[]
}

/**
 * Cheap by construction UNLESS `probe` is passed: the endpoint gathers nothing that costs egress on
 * its own, so opening and polling the board is safe. `probe: true` opts into contacting the default
 * model's provider, which is why it is a separate user action and never the page load.
 */
export function instanceDiagnosis(
  server: ServerConnection.HttpBase,
  options?: { readonly probe?: boolean; readonly signal?: AbortSignal },
) {
  return instanceFetch<Diagnosis>(server, {
    route: options?.probe === true ? "api/diagnosis?probe=provider" : "api/diagnosis",
    signal: options?.signal,
    timeoutMs: 20_000,
  })
}
