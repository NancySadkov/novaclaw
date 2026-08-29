import { createSignal } from "solid-js"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// The persisted half of the app registry (B14): server-side manifests written by the agent's
// `register-app` tool (or POST /app), fetched over the V1 instance API. A manifest is a LAUNCHER —
// open a closed route id, a URL, or a chat draft pre-filled with a prompt — never code. This module
// holds the DATA (a module signal, like registry.tsx); mapping manifests to HomeApps with live openers
// is the home screen's job (openers need component scope: navigate/tabs).

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
    .then((res) => (res.ok ? (res.json() as Promise<unknown>) : undefined))
    .catch(() => undefined)
  // ⚠️ `rows` was cast to AppManifest[] and published on truthiness alone. `{}` is truthy, so a peer
  // answering an object put a non-array into the signal and the home screen's
  // `persistedManifests().map(...)` threw inside a render — which the app error boundary turns into
  // "Something went wrong" for the WHOLE UI. A launcher tile we cannot parse must not cost the user
  // their session (AGENTS.md → *it never breaks in your hands*). Instances are PEERS on possibly
  // different versions, so an unexpected shape here is a normal condition, not a one-off bug.
  // Same defect and same fix as `utils/messenger-api.ts` → `callList`, found together 2026-07-28.
  if (rows === undefined) return
  if (!Array.isArray(rows)) {
    const shape = rows === null ? "null" : typeof rows
    console.warn(`apps: GET /app answered ${shape}, not a list of manifests — showing none.`)
    return
  }
  setManifests(rows as readonly AppManifest[])
}

/**
 * Delete a persisted app manifest (DELETE /app/:id), then drop it from the signal.
 *
 * 🔴 Registering a tile was reachable and removing one was not, so an agent could add to the user's
 * home screen and nothing in the product could take it back off. Raw fetch for the same reason
 * `loadPersistedApps` uses one: this endpoint postdates the generated SDK.
 *
 * The local splice is not an optimisation — the server broadcasts `app.registered`, which every
 * client refetches on, but the window that did the deleting should not wait for its own round trip
 * to stop showing a tile the user just threw away.
 */
export async function deletePersistedApp(server: ServerConnection.HttpBase, id: string): Promise<boolean> {
  // `/api/app/:id` — the modern contract. Listing and registering are still the legacy `/app`, and
  // that asymmetry is deliberate: ruling 11 pins the legacy surface shrink-only, so a NEW route may
  // not join it. `sdk-js`'s legacy-path ledger enforces that, and caught the first draft of this.
  const url = new URL(`api/app/${encodeURIComponent(id)}`, server.url.endsWith("/") ? server.url : `${server.url}/`)
  const ok = await fetch(url, {
    method: "DELETE",
    headers: server.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
      : {},
  })
    .then((res) => res.ok)
    .catch(() => false)
  if (ok) setManifests((prev) => prev.filter((manifest) => manifest.id !== id))
  return ok
}
