import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// Remote-access R7: raw-fetch helper for GET /global/discovery (golden rule: never hand-edit the
// generated SDK — same recipe as utils/fs-api.ts). The SCANNING instance answers with the
// NovaClaw instances it can see on ITS local network via mDNS; the UI itself never opens
// multicast sockets (the web build cannot, and the thin client may not even be on that LAN).
export interface DiscoveredInstance {
  readonly name: string
  readonly url: string
  readonly instanceID?: string
  readonly version?: string
  /** True when the discovered instance IS the scanning instance itself. */
  readonly self: boolean
}

export async function discoverInstances(server: ServerConnection.HttpBase): Promise<DiscoveredInstance[]> {
  const url = new URL("global/discovery", server.url.endsWith("/") ? server.url : `${server.url}/`)
  const res = await fetch(url, {
    headers: server.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
      : {},
  })
  if (!res.ok) throw new Error(`GET global/discovery failed: ${res.status}`)
  const body = (await res.json()) as { instances?: DiscoveredInstance[] }
  return body.instances ?? []
}
