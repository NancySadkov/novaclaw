import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

// Remote-access R7: GET /global/discovery. The SCANNING instance answers with the NovaClaw
// instances it can see on ITS local network via mDNS; the UI itself never opens multicast sockets
// (the web build cannot, and the thin client may not even be on that LAN).
//
// ⚠️ Despite the name, this is NOT a probe of other instances — it is an ordinary call to the ONE
// connected instance, which is why it belongs on the shared seam rather than beside it. The only
// thing it did differently was omit `content-type` on its bodyless GET; through
// `utils/instance-fetch.ts` it now sends the same headers as its eight siblings.
export interface DiscoveredInstance {
  readonly name: string
  readonly url: string
  readonly instanceID?: string
  readonly version?: string
  /** True when the discovered instance IS the scanning instance itself. */
  readonly self: boolean
}

export async function discoverInstances(server: ServerConnection.HttpBase): Promise<DiscoveredInstance[]> {
  const body = await instanceFetch<{ instances?: DiscoveredInstance[] }>(server, { route: "global/discovery" })
  return body.instances ?? []
}
