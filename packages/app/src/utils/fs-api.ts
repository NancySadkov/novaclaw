import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

type CallOptions = { readonly signal?: AbortSignal; readonly timeoutMs?: number }

// The FS-1b write endpoints (M4) plus the live session controls, the provider/shell probes and the
// ad-hoc recipe surface — the widest of this folder's instance clients.
//
// `call` paths are RELATIVE to `directory` (the routed root); the server re-asserts containment.
//
// ⚠️ Base URL, auth, and fault decoding live in `utils/instance-fetch.ts`. This file previously
// exported `headersFor` "so sibling raw-fetch clients reuse the SAME auth handling" — one sibling
// took it up (`session-pending-api.ts`), seven re-derived it anyway, and an exported header helper
// was never going to be the thing that held them together. `instanceHeaders` is.

export interface TrashEntry {
  readonly id: string
  readonly originalPath: string
  readonly trashedAt: number
  readonly type: "file" | "directory"
}

const call = <T>(
  server: ServerConnection.HttpBase,
  method: "GET" | "POST" | "PUT" | "DELETE",
  route: string,
  directory: string,
  body?: unknown,
  options?: CallOptions,
): Promise<T> => instanceFetch<T>(server, { method, route, directory, body, ...options })

export function fsWrite(
  server: ServerConnection.HttpBase,
  input: { directory: string; path: string; content: string },
) {
  return call<{ ok: true }>(server, "PUT", "file/content", input.directory, {
    path: input.path,
    content: input.content,
  })
}

export function fsMkdir(
  server: ServerConnection.HttpBase,
  input: { directory: string; path: string; exclusive?: boolean },
) {
  return call<{ ok: true }>(server, "POST", "file/mkdir", input.directory, {
    path: input.path,
    ...(input.exclusive === undefined ? {} : { exclusive: input.exclusive }),
  })
}

export function fsRename(server: ServerConnection.HttpBase, input: { directory: string; path: string; name: string }) {
  return call<{ path: string }>(server, "POST", "file/rename", input.directory, {
    path: input.path,
    name: input.name,
  })
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
  readonly discoveryLatencyMs?: number
  readonly completionLatencyMs?: number
  readonly completionAttempts?: number
  readonly completed?: boolean
  readonly window?: number
  readonly limits?: Readonly<Record<string, { readonly context?: number; readonly output?: number }>>
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
    signal?: AbortSignal
  },
) {
  return call<ProbeResult>(
    server,
    "POST",
    `provider/${encodeURIComponent(input.providerID)}/probe`,
    input.directory,
    {
      ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
      ...(input.baseURL === undefined ? {} : { baseURL: input.baseURL }),
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.authStyle === undefined ? {} : { authStyle: input.authStyle }),
    },
    { signal: input.signal, timeoutMs: 7_000 },
  )
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

export function providerPresets(server: ServerConnection.HttpBase, input: { directory: string; signal?: AbortSignal }) {
  return call<Record<string, ProviderPreset>>(server, "GET", "provider/presets", input.directory, undefined, {
    signal: input.signal,
    timeoutMs: 5_000,
  })
}

export interface LocalModelProfile {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly modelID: string
  readonly quant: string
  readonly license: string
  readonly sourceURL: string
  readonly downloadBytes: number
  readonly minimumMemoryBytes: number
  readonly workingMemoryBytes: number
  readonly contexts: readonly number[]
}

export interface LocalModelStatus {
  readonly supported: boolean
  readonly platform: string
  readonly profiles: readonly LocalModelProfile[]
  readonly stage:
    | "idle"
    | "checking"
    | "downloading-runtime"
    | "installing-runtime"
    | "downloading-model"
    | "installed"
    | "starting"
    | "ready"
    | "stopping"
    | "error"
  readonly profileID?: string
  readonly completed?: number
  readonly total?: number
  readonly message?: string
  readonly detail?: string
  readonly baseURL?: string
  readonly modelID?: string
  readonly context?: number
  readonly output?: number
  readonly pid?: number
  readonly ramBytes?: number
  readonly preflight?: {
    readonly ok: boolean
    readonly issues: readonly string[]
    readonly warnings: readonly string[]
    readonly memory?: { readonly freeBytes: number; readonly limitBytes: number }
    readonly disk?: { readonly freeBytes: number; readonly requiredBytes: number }
  }
  readonly recommendedContext: number
}

export function localModelStatus(
  server: ServerConnection.HttpBase,
  input: { directory: string; signal?: AbortSignal },
) {
  return call<LocalModelStatus>(server, "GET", "api/provider/local-models", input.directory, undefined, {
    signal: input.signal,
    timeoutMs: 15_000,
  })
}

export function localModelInstall(
  server: ServerConnection.HttpBase,
  input: { directory: string; profileID: string; context?: number },
) {
  return call<LocalModelStatus>(
    server,
    "POST",
    `api/provider/local-models/${encodeURIComponent(input.profileID)}/install`,
    input.directory,
    { ...(input.context === undefined ? {} : { context: input.context }) },
  )
}

export function localModelStop(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<LocalModelStatus>(server, "POST", "api/provider/local-models/stop", input.directory)
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
  readonly layers: ReadonlyArray<{
    readonly layer: number
    readonly name: string
    readonly active: boolean
    readonly detail?: string
  }>
}

export function offlineStatus(server: ServerConnection.HttpBase, input: { directory: string }) {
  return call<OfflineStatus>(server, "GET", "shell/offline", input.directory)
}

// B10/1K — live session controls. Routed by the `x-novaclaw-directory` HEADER rather than a query
// param (the `/api/session/*` surface), and every one of them is declared 204 no-content.
const sessionPost = (
  server: ServerConnection.HttpBase,
  directory: string,
  sessionID: string,
  segment: string,
  body: unknown,
): Promise<void> =>
  instanceFetch<void>(server, {
    method: "POST",
    route: `api/session/${sessionID}/${segment}`,
    directory,
    directoryVia: "header",
    body,
  })

// Export a whole session as a Markdown file into `directory` (Chats → Export). Returns where it landed
// plus whether the session was still running — the caller says so in its toast, and the file says so too.
export interface SessionExportResult {
  path: string
  messageCount: number
  running: boolean
}

// The server puts a legible reason in `message` (e.g. an unwritable folder) and the seam prefers it
// over the status line — the behaviour this function used to hand-roll on its own.
export function exportSessionMarkdown(
  server: ServerConnection.HttpBase,
  input: { directory: string; sessionID: string; into: string; filename?: string },
): Promise<SessionExportResult> {
  return instanceFetch<SessionExportResult>(server, {
    method: "POST",
    route: `api/session/${input.sessionID}/export-markdown`,
    directory: input.directory,
    directoryVia: "header",
    body: { directory: input.into, ...(input.filename ? { filename: input.filename } : {}) },
  })
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

// A per-session harness-feature toggle (the composer's Tuning control). `enabled: null` clears the
// override back to inherit (global config).
//
// ⚠️ This is the WIRE-side spelling of `SessionFeature.Name` (`packages/schema/src/session-feature.ts`)
// and it is a third copy of that union — the schema's, the composer's `ComposerFeature`, and this
// one. It is kept separate because this file is a raw-fetch client that deliberately does not depend
// on the kernel schema, but the duplication is real and it is why adding `safeMode` (2026-07-31)
// touched three files. `packages/core/test/session-safe-mode.test.ts` pins the schema↔composer half;
// this half is only checked by the compiler, at the `switchFeature` call sites.
export type SessionFeatureName =
  | "introspection"
  | "quality"
  | "affective"
  | "thinkingBudget"
  | "surgicalEdits"
  | "askBeforeChanges"
  | "safeMode"
  | "contextBudget"

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
