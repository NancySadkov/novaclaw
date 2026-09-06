import { createSignal } from "solid-js"
import { isManifestRouteId } from "@novaclaw/core/app-route"
import type { ServerConnection } from "@/context/server"
import { instanceFetch, instanceFetchResponse } from "@/utils/instance-fetch"

// The persisted half of the app registry (B14): server-side manifests written by the agent's
// `register-app` tool (or POST /app), fetched over the V1 instance API. A manifest is a LAUNCHER —
// open a closed route id, a URL, or a chat draft pre-filled with a prompt — never code. This module
// holds the DATA in server-keyed buckets (a module signal, like registry.tsx); mapping manifests to
// HomeApps with live openers is the home screen's job (openers need component scope: navigate/tabs).

export interface AppManifest {
  readonly id: string
  readonly title: string
  readonly icon?: string
  readonly accent?: string
  readonly subtitle?: string
  readonly open: { readonly type: "route" | "url" | "prompt"; readonly value: string }
  readonly source?: "agent" | "plugin"
  readonly createdAt: number
  readonly updatedAt: number
}

const [manifests, setManifests] = createSignal<Record<string, readonly AppManifest[]>>({})
let lastServerKey = ""
const loadRevision = new Map<string, number>()

const defaultServerKey = (server: ServerConnection.HttpBase) => server.url.replace(/\/+$/, "")
/** Read only the bucket belonging to the instance currently being rendered. */
export const persistedManifests = (serverKey?: string): readonly AppManifest[] =>
  manifests()[serverKey ?? lastServerKey] ?? []

const OPEN_TYPES = new Set<AppManifest["open"]["type"]>(["route", "url", "prompt"])
const ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/

/** Decode peer-supplied launcher data before it reaches a reactive render. */
function isManifest(value: unknown): value is AppManifest {
  if (typeof value !== "object" || value === null) return false
  const row = value as Record<string, unknown>
  if (typeof row.id !== "string" || !ID_PATTERN.test(row.id)) return false
  if (typeof row.title !== "string" || row.title.trim() === "") return false
  if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) return false
  if (typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)) return false
  if (row.source !== undefined && row.source !== "agent" && row.source !== "plugin") return false
  for (const key of ["icon", "accent", "subtitle"] as const) {
    if (row[key] !== undefined && typeof row[key] !== "string") return false
  }
  if (typeof row.open !== "object" || row.open === null) return false
  const open = row.open as Record<string, unknown>
  if (typeof open.type !== "string" || !OPEN_TYPES.has(open.type as AppManifest["open"]["type"])) return false
  if (typeof open.value !== "string" || open.value.trim() === "") return false
  if (open.type === "route" && !isManifestRouteId(open.value)) return false
  if (open.type === "url" && !/^https?:\/\//.test(open.value)) return false
  return true
}

/**
 * Fetch `GET /app` through the one HTTP seam and publish the signal.
 *
 * ⚠️ **Not a raw `fetch` any more (2026-09-01).** This file was the TENTH raw-fetch client and the
 * one outside `utils/`, so it carried its own base-URL join and its own `Authorization` derivation —
 * i.e. it was the copy a P2P token rotation would miss, which is the failure `instance-fetch.ts`
 * exists to make impossible. Its own header comment named this file by path. Both ledger lines in
 * `utils/instance-fetch.test.ts` (`RAW_FETCH_OFFENDERS`, `CREDENTIAL_SITES`) were deleted with this
 * change; that test fails if a converted file is left pinned, and fails if a pinned file is
 * converted back.
 *
 * ⚠️ **It calls `instanceFetch`, NOT `instanceFetchList`, and that is deliberate.** The guard is the
 * same one — `{}` is truthy, so a peer answering an object used to put a non-array into the signal
 * and the home screen's `persistedManifests().map(...)` threw inside a render, which the app error
 * boundary turns into "Something went wrong" for the WHOLE UI — but the RECOVERY differs.
 * `instanceFetchList` coerces to `[]` for `createResource` clients, which start empty anyway. This
 * is a module signal that outlives the request: coercing would DELETE tiles the user is already
 * looking at because one poll came back malformed, and a launcher manifest still opens correctly
 * from the copy we hold. So a bad shape is named and the last good list is kept. Instances are
 * PEERS on possibly different versions, so an unexpected shape here is a normal condition, not a
 * one-off bug.
 *
 * ⚠️ A non-2xx no longer folds silently to "no apps": the seam decodes the fault and it is named on
 * the console, which `utils/error-log.ts` taps into the Debug app (ruling 2 — an unavailable
 * subsystem names itself instead of rendering empty). The signal is left untouched, and this
 * function still never rejects: both call sites (`apps/manifest-apps.ts:42`,
 * `context/server-sync.tsx:406`) invoke it with `void`, where a rejection would be unhandled.
 */
export async function loadPersistedApps(
  server: ServerConnection.HttpBase,
  serverKey = defaultServerKey(server),
): Promise<void> {
  lastServerKey = serverKey
  const revision = (loadRevision.get(serverKey) ?? 0) + 1
  loadRevision.set(serverKey, revision)
  const rows = await instanceFetch<unknown>(server, { route: "app" }).catch((error: unknown) => {
    console.warn(`apps: GET /app failed — keeping the tiles already shown. ${faultText(error)}`)
    return undefined
  })
  if (rows === undefined) return
  if (!Array.isArray(rows)) {
    console.warn(
      `apps: GET /app answered ${rows === null ? "null" : typeof rows}, not a list of manifests — ` +
        `keeping the tiles already shown. The instance may be running a different version.`,
    )
    return
  }
  const valid: AppManifest[] = []
  for (const [index, row] of rows.entries()) {
    if (isManifest(row)) {
      valid.push(row)
      continue
    }
    // Report only the bounded index/id. Never echo a prompt or URL from untrusted peer data into
    // diagnostics, and never let one malformed tile poison valid siblings.
    const id = typeof row === "object" && row !== null && typeof (row as Record<string, unknown>).id === "string"
      ? ` id=${JSON.stringify((row as Record<string, unknown>).id)}`
      : ""
    console.warn(`apps: GET /app skipped malformed manifest at index ${index}${id}`)
  }
  // A background instance can finish after the focused one, so a response may only publish into
  // the bucket whose request issued it. A newer request for this same instance wins by revision.
  if (loadRevision.get(serverKey) !== revision) return
  setManifests((previous) => ({ ...previous, [serverKey]: valid }))
}

const faultText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Delete a persisted app manifest (DELETE /app/:id), then drop it from the signal.
 *
 * 🔴 Registering a tile was reachable and removing one was not, so an agent could add to the user's
 * home screen and nothing in the product could take it back off.
 *
 * The local splice is not an optimisation — the server broadcasts `app.registered`, which every
 * client refetches on, but the window that did the deleting should not wait for its own round trip
 * to stop showing a tile the user just threw away.
 *
 * Returns a plain boolean rather than throwing because the one caller
 * (`pages/home-screen/home-screen.tsx:150`) branches on it to decide whether to keep the tile; the
 * fault is still decoded and named by the seam on the way past.
 */
export async function deletePersistedApp(
  server: ServerConnection.HttpBase,
  id: string,
  serverKey = defaultServerKey(server),
): Promise<boolean> {
  // Do not let an older list response reintroduce a tile after this instance's deletion succeeds.
  loadRevision.set(serverKey, (loadRevision.get(serverKey) ?? 0) + 1)
  // `/api/app/:id` — the modern contract. Listing and registering are still the legacy `/app`, and
  // that asymmetry is deliberate: ruling 11 pins the legacy surface shrink-only, so a NEW route may
  // not join it. `sdk-js`'s legacy-path ledger enforces that, and caught the first draft of this.
  //
  // ⚠️ **`instanceFetchResponse` with a reader that ignores the body, NOT `instanceFetch<void>`.**
  // A/B'd over six answers on 2026-09-01: the two agree on 204, on a JSON body, on 404, on 500 and
  // on a transport throw, and DISAGREE on `200` with an EMPTY body — `instanceFetch` treats a 2xx
  // that promised JSON and sent none as a fault, so the delete would report failure and the tile
  // would come back. The endpoint is declared `NoContent` (`protocol/src/groups/app.ts`) so our own
  // server sends 204, but instances are PEERS on possibly different versions and a proxy can
  // normalise 204 to 200. The pre-seam code was `res.ok`, and `res.ok` is what this must stay.
  const ok = await instanceFetchResponse(
    server,
    {
      method: "DELETE",
      route: `api/app/${encodeURIComponent(id)}`,
    },
    async () => true,
  ).catch((error: unknown) => {
    console.warn(`apps: DELETE api/app/${id} failed — the tile stays. ${faultText(error)}`)
    return false
  })
  if (ok)
    setManifests((previous) => ({
      ...previous,
      [serverKey]: (previous[serverKey] ?? []).filter((manifest) => manifest.id !== id),
    }))
  return ok
}
