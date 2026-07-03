import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// Raw-fetch helpers for the FS-1b write endpoints (M4). These are NOT in the generated SDK
// (golden rule: never hand-edit packages/sdk/js/src/gen/**), so the app calls them with plain
// fetch using exactly the createSdkForServer auth recipe (utils/server.ts).
//
// All paths are RELATIVE to `directory` (the routed root); the server re-asserts containment.

export interface TrashEntry {
  readonly id: string
  readonly originalPath: string
  readonly trashedAt: number
  readonly type: "file" | "directory"
}

function headersFor(server: ServerConnection.HttpBase): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(server.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
      : {}),
  }
}

async function call<T>(
  server: ServerConnection.HttpBase,
  method: "GET" | "POST" | "PUT",
  route: string,
  directory: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(route, server.url.endsWith("/") ? server.url : `${server.url}/`)
  url.searchParams.set("directory", directory)
  const res = await fetch(url, {
    method,
    headers: headersFor(server),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${route} failed: ${res.status} ${await res.text().catch(() => "")}`)
  return (await res.json()) as T
}

export function fsWrite(
  server: ServerConnection.HttpBase,
  input: { directory: string; path: string; content: string },
) {
  return call<{ ok: true }>(server, "PUT", "file/content", input.directory, {
    path: input.path,
    content: input.content,
  })
}

export function fsMkdir(server: ServerConnection.HttpBase, input: { directory: string; path: string }) {
  return call<{ ok: true }>(server, "POST", "file/mkdir", input.directory, { path: input.path })
}

export function fsTrash(server: ServerConnection.HttpBase, input: { directory: string; path: string }) {
  return call<TrashEntry>(server, "POST", "file/trash", input.directory, { path: input.path })
}

export function fsTrashList(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<TrashEntry[]>(server, "GET", "file/trash", input.directory)
}

export function fsTrashRestore(server: ServerConnection.HttpBase, input: { directory: string; id: string }) {
  return call<{ restoredPath: string }>(server, "POST", "file/trash/restore", input.directory, { id: input.id })
}

// B15 — provider/model health probe (codehamr A8). One GET {baseURL}/models round trip
// server-side; classifies ok / unreachable / auth / model-missing and reports the honored
// context window where the server exposes it (vLLM max_model_len).
export interface ProbeResult {
  readonly status: "ok" | "unreachable" | "auth" | "model-missing" | "no-url" | "error"
  readonly latencyMs?: number
  readonly window?: number
  readonly detail?: string
  readonly models?: readonly string[]
}

export function providerProbe(
  server: ServerConnection.HttpBase,
  input: { directory: string; providerID: string; modelID?: string; baseURL?: string; apiKey?: string },
) {
  return call<ProbeResult>(server, "POST", `provider/${encodeURIComponent(input.providerID)}/probe`, input.directory, {
    ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
    ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
  })
}

// B11 — the bundled-shell substrate (status + provisioner). Provisioning downloads
// ~59 MB and extracts for a minute; the caller shows a busy state and awaits.
export interface ShellStatus {
  readonly platform: string
  readonly agentShell: string
  readonly bash: string | null
  readonly git: string | null
  readonly bundle: {
    readonly root: string
    readonly bash: string
    readonly git: string
    readonly version?: string
    readonly provisionedAt?: number
  } | null
  readonly provisionSupported: boolean
}

export function shellStatus(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<ShellStatus>(server, "GET", "shell/status", input.directory)
}

export function shellProvision(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<ShellStatus>(server, "POST", "shell/provision", input.directory)
}

// OFF-C — the N/9 offline-layer posture (the airgap status indicator).
export interface OfflineStatus {
  readonly enabled: boolean
  readonly active: number
  readonly total: number
  readonly layers: ReadonlyArray<{ readonly layer: number; readonly name: string; readonly active: boolean; readonly detail?: string }>
}

export function offlineStatus(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<OfflineStatus>(server, "GET", "shell/offline", input.directory)
}

// B10/1K — live session controls. These V2 endpoints are NOT in the generated SDK; call them
// raw with the x-novaclaw-directory header (session-location routing) and tolerate 204.
async function sessionPost(
  server: ServerConnection.HttpBase,
  directory: string,
  sessionID: string,
  segment: string,
  body: unknown,
): Promise<void> {
  const url = new URL(
    `api/session/${sessionID}/${segment}`,
    server.url.endsWith("/") ? server.url : `${server.url}/`,
  )
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headersFor(server), "x-novaclaw-directory": directory },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`session/${segment} failed: ${res.status} ${await res.text().catch(() => "")}`)
}

export function switchResponder(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; responder: "nova" | "operator" },
) {
  return sessionPost(server, input.directory, input.sessionID, "responder", { responder: input.responder })
}

// 1K — mid-session permission-mode switch.
export function switchMode(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; permissionMode: "plan" | "ask" | "surgical" | "bypass" | "yolo" },
) {
  return sessionPost(server, input.directory, input.sessionID, "mode", { permissionMode: input.permissionMode })
}
