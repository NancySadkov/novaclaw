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

export interface InstanceResources {
  readonly measuredAt: number
  readonly level: "ok" | "warning" | "floor" | "unknown"
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

export function instanceResources(server: ServerConnection.HttpBase, signal?: AbortSignal) {
  return instanceFetch<InstanceResources>(server, { route: "global/resources", signal, timeoutMs: 20_000 })
}
