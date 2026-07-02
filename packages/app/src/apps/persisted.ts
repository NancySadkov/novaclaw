import { createSignal } from "solid-js"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// The persisted half of the app registry (B14): server-side manifests written by the agent's
// `register-app` tool (or POST /app), fetched over the V1 instance API. A manifest is a LAUNCHER —
// open a route, a URL, or a chat draft pre-filled with a prompt — never code. This module holds the
// DATA (a module signal, like registry.tsx); mapping manifests to HomeApps with live openers is the
// home screen's job (openers need component scope: navigate/tabs).

export interface AppManifest {
  readonly id: string
  readonly title: string
  readonly icon?: string
  readonly accent?: string
  readonly subtitle?: string
  readonly open: { readonly type: "route" | "url" | "prompt"; readonly value: string }
  readonly createdAt: number
  readonly updatedAt: number
}

const [manifests, setManifests] = createSignal<readonly AppManifest[]>([])
export const persistedManifests = manifests

/** Fetch GET /app (raw fetch — the endpoint postdates the generated SDK) and publish the signal. */
export async function loadPersistedApps(server: ServerConnection.HttpBase): Promise<void> {
  const url = new URL("app", server.url.endsWith("/") ? server.url : `${server.url}/`)
  const rows = await fetch(url, {
    headers: server.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
      : {},
  })
    .then((res) => (res.ok ? (res.json() as Promise<AppManifest[]>) : undefined))
    .catch(() => undefined)
  if (rows) setManifests(rows)
}
