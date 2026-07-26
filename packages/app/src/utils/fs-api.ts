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

/** Auth/content headers for a raw fetch against a server connection. Exported so sibling raw-fetch
 *  clients reuse the SAME auth handling instead of each re-deriving it. */
export function headersFor(server: ServerConnection.HttpBase): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(server.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
      : {}),
  }
}

async function call<T>(
  server: ServerConnection.HttpBase,
  method: "GET" | "POST" | "PUT" | "DELETE",
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
  input: {
    directory: string
    providerID: string
    modelID?: string
    baseURL?: string
    apiKey?: string
    authStyle?: "bearer" | "anthropic"
  },
) {
  return call<ProbeResult>(server, "POST", `provider/${encodeURIComponent(input.providerID)}/probe`, input.directory, {
    ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
    ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.authStyle === undefined ? {} : { authStyle: input.authStyle }),
  })
}

// Provider-import presets (Settings → Models → Add models): the server-merged view of the
// builtin preset catalog ⊕ the `provider_presets` config overrides — fetched fresh on every
// dialog open so a runtime endpoint repair (self-healing PATCH /config) shows immediately.
export interface ProviderPreset {
  readonly name?: string
  readonly description?: string
  readonly baseURL?: string
  readonly keyURL?: string
  readonly api?: "@ai-sdk/openai" | "@ai-sdk/anthropic" | "@ai-sdk/openai-compatible"
  readonly authStyle?: "bearer" | "anthropic"
  readonly hidden?: boolean
}

export function providerPresets(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<Record<string, ProviderPreset>>(server, "GET", "provider/presets", input.directory)
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

// Export a whole session as a Markdown file into `directory` (Chats → Export). Returns where it landed
// plus whether the session was still running — the caller says so in its toast, and the file says so too.
export interface SessionExportResult {
  path: string
  messageCount: number
  running: boolean
}

export async function exportSessionMarkdown(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; into: string; filename?: string },
): Promise<SessionExportResult> {
  const url = new URL(
    `api/session/${input.sessionID}/export-markdown`,
    server.url.endsWith("/") ? server.url : `${server.url}/`,
  )
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headersFor(server), "x-novaclaw-directory": input.directory },
    body: JSON.stringify({ directory: input.into, ...(input.filename ? { filename: input.filename } : {}) }),
  })
  const text = await res.text().catch(() => "")
  if (!res.ok) {
    // The server puts a legible reason in `message` (e.g. an unwritable folder) — prefer it over the status.
    let detail = `${res.status} ${text}`
    try {
      const parsed = JSON.parse(text) as { message?: string }
      if (parsed.message) detail = parsed.message
    } catch {
      /* not json — keep the status line */
    }
    throw new Error(detail)
  }
  return JSON.parse(text) as SessionExportResult
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

// The per-session Strict-harness override (the composer's Strict switch — jh.md).
// `strict: null` clears the override back to inherit (global Settings → Strict mode).
export interface SessionStrictOverride {
  enabled?: boolean
  attempts?: number
  wallMinutes?: number
}

export function switchStrict(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; strict: SessionStrictOverride | null },
) {
  return sessionPost(server, input.directory, input.sessionID, "strict", { strict: input.strict })
}

// A per-session harness-feature toggle (the composer's Tuning control — introspection ·
// quality · affective). `enabled: null` clears the override back to inherit (global config).
export type SessionFeatureName = "introspection" | "quality" | "affective" | "thinkingBudget" | "surgicalEdits" | "askBeforeChanges"

export function switchFeature(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; feature: SessionFeatureName; enabled: boolean | null },
) {
  return sessionPost(server, input.directory, input.sessionID, "feature", {
    feature: input.feature,
    enabled: input.enabled,
  })
}

// The chat's kernel thread type (the composer's Mode control). Attendance derives from the chain
// root's type: an unattended chat (auto-prompting · goal-oriented) DENIES out-of-folder writes and runs bash
// confined by the Agent Jail. "sub-agent" is spawn-only, so the switch offers these three.
export type SessionModeName = "interactive" | "auto-prompting" | "goal-oriented"

export function switchType(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; type: SessionModeName },
) {
  return sessionPost(server, input.directory, input.sessionID, "type", { type: input.type })
}

// B4/T2: the per-session system-prompt override layer (the info-sheet editor; the agent-side
// counterpart is the `reconfigure` tool). `override: null` clears the layer.
export function switchPromptOverride(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; override: string | null },
) {
  return sessionPost(server, input.directory, input.sessionID, "prompt-override", { override: input.override })
}

// 4E (small-tails T5): the session-defined ad-hoc recipe review surface.
export type AdhocRecipe = { name: string; description: string; manual: string; enabled?: boolean }

export function adhocList(server: ServerConnection.HttpBase, input: { directory: string; sessionID: string }) {
  return call<AdhocRecipe[]>(server, "GET", `adhoc/session/${encodeURIComponent(input.sessionID)}`, input.directory)
}

export function adhocDiscard(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; name: string },
) {
  return call<{ removed: boolean }>(
    server,
    "DELETE",
    `adhoc/session/${encodeURIComponent(input.sessionID)}/${encodeURIComponent(input.name)}`,
    input.directory,
  )
}

export function adhocPromote(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; name: string },
) {
  return call<{ promoted: string }>(
    server,
    "POST",
    `adhoc/session/${encodeURIComponent(input.sessionID)}/${encodeURIComponent(input.name)}/promote`,
    input.directory,
  )
}
