import type { ServerConnection } from "@/context/server"
import { instanceFetch, instanceFetchList } from "@/utils/instance-fetch"

export type CapabilityStatus =
  | { readonly state: "idle" }
  | { readonly state: "starting"; readonly since: number }
  | { readonly state: "ready"; readonly since: number }
  | {
      readonly state: "unavailable"
      readonly reason: {
        readonly capability: string
        readonly kind: "failed" | "timeout" | "disabled" | "unsupported"
        readonly summary: string
        readonly detail?: string
        readonly repair?: readonly string[]
      }
      readonly at: number
      readonly attempts: number
    }

export interface CapabilitySnapshot {
  readonly name: string
  readonly status: CapabilityStatus
}

export function capabilities(server: ServerConnection.HttpBase, directory: string) {
  return instanceFetchList<CapabilitySnapshot>(server, { route: "api/capability", directory }, "optional capabilities")
}

export function retryCapability(server: ServerConnection.HttpBase, name: string, directory: string) {
  return instanceFetch<CapabilitySnapshot>(server, {
    method: "POST",
    route: `api/capability/${encodeURIComponent(name)}/retry`,
    directory,
  })
}
