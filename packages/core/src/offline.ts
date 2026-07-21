// OFF-A — offline / airgap mode, layers 1–2: the HTTP-client allowlist chokepoint.
//
// When offline mode is ON, the shared Effect `HttpClient` (the single chokepoint the
// V2 LLM RequestExecutor, webfetch, probe, share, … all ride) refuses any host that
// is not (a) loopback or (b) a configured model-provider host. Fail-closed with a
// legible error naming the blocked host and how to allow it.
//
// Policy sources (snapshot at layer init — a machine-level invariant, not per-request):
//   - `NOVACLAW_OFFLINE` env ("true"/"1") OR `offline: true` in the SETTINGS STORE (config-sqlite:
//     the runtime_setting SQLite row is the runtime truth; the jsonc file is only consulted
//     before the FIRST boot has seeded the stores — at that moment it IS the declared config).
//   - allowlist = hosts of every catalog_provider layer's `api.url` (V2 vocabulary; same pre-seed
//     jsonc fallback). Post config-sqlite the catalog is INSTANCE-WIDE (one `catalog_provider` row
//     per provider, no location key), and `readStorePolicy` reads them ALL — so every provider the
//     instance knows is on the allowlist; there is no separate per-location provider set to miss.
//     (The old "project-scoped providers are invisible here" caveat predated config-sqlite.) Plus
//   - `NOVACLAW_OFFLINE_ALLOW` env: comma-separated extra hosts (e.g. a LAN SearXNG).
//   - Loopback (localhost / 127.0.0.0/8 / ::1) is ALWAYS allowed: the app talking to
//     itself is not egress; the airgap threat model is the WAN. Layer 9 (OFF-C)
//     handles the model's own shell processes.
//
// The block error is an HttpClientError with an InvalidUrlError reason — 1D's
// provider-retry classifies that FATAL (never retried), unlike Transport.
import fs from "fs"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import { parse } from "jsonc-parser"
import { readRowsSync } from "#sqlite"
import { DatabasePath } from "./database/db-path"
import { Global } from "./global"
import { makeGlobalNode } from "./effect/app-node"

export interface Policy {
  readonly enabled: boolean
  readonly allowedHosts: ReadonlySet<string>
}

export const disabledPolicy: Policy = { enabled: false, allowedHosts: new Set() }

const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/^\[|\]$/g, "")

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return normalized === "localhost" || normalized === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
}

/** Hostname of an absolute URL; undefined for relative/unparseable inputs (not egress). */
export function hostFromUrl(url: string): string | undefined {
  try {
    return normalizeHost(new URL(url).hostname)
  } catch {
    return undefined
  }
}

export function parseAllowList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((entry) => normalizeHost(entry))
    .filter((entry) => entry.length > 0)
}

/** The endpoint host of one provider fragment (ConfigProvider.Info shape): `api.url` — the V2
 *  vocabulary (F1-config; the V1 `provider.*.options.baseURL` never survives the V2 decode). */
function providerHost(entry: unknown): string | undefined {
  const url = (entry as { api?: { url?: unknown } } | undefined)?.api?.url
  return typeof url === "string" ? hostFromUrl(url) : undefined
}

/** Hostnames of every `providers.*.api.url` in a (decoded-or-raw) V2 config object. */
export function providerHostsFromConfig(config: unknown): string[] {
  const providers = (config as { providers?: Record<string, unknown> } | undefined)?.providers
  if (!providers || typeof providers !== "object") return []
  const hosts: string[] = []
  for (const entry of Object.values(providers)) {
    const host = providerHost(entry)
    if (host) hosts.push(host)
  }
  return hosts
}

export type Verdict = { readonly allowed: true } | { readonly allowed: false; readonly host: string; readonly message: string }

export function checkUrl(url: string, policy: Policy): Verdict {
  if (!policy.enabled) return { allowed: true }
  const host = hostFromUrl(url)
  if (host === undefined) return { allowed: true }
  if (isLoopbackHost(host)) return { allowed: true }
  if (policy.allowedHosts.has(host)) return { allowed: true }
  const allowed = policy.allowedHosts.size ? [...policy.allowedHosts].sort().join(", ") : "none"
  return {
    allowed: false,
    host,
    message:
      `Offline mode: request to host '${host}' blocked (fail-closed). ` +
      `Only loopback and the configured model-provider hosts are reachable (allowed: ${allowed}). ` +
      `To allow it: add the provider globally (Settings → Models), extend NOVACLAW_OFFLINE_ALLOW ` +
      `(comma-separated hosts), or turn offline mode off.`,
  }
}

const truthy = (value: string | undefined) => value === "true" || value === "1"

const CONFIG_NAMES = ["config.json", "novaclaw.json", "novaclaw.jsonc"]

/** Read the GLOBAL config file (first of the known names that parses). Sync + tolerant. Post
 *  config-sqlite this is ONLY the pre-first-boot fallback: before `seedAll` has imported the file
 *  into the stores, the file IS the declared config; afterwards the stores are the truth and a
 *  stale exported jsonc must not override them. */
function readGlobalConfig(configDir: string): unknown {
  for (const name of CONFIG_NAMES) {
    try {
      const text = fs.readFileSync(path.join(configDir, name), "utf8")
      const parsed: unknown = parse(text, [], { allowTrailingComma: true })
      if (parsed && typeof parsed === "object") return parsed
    } catch {
      // missing/unreadable file → try the next name
    }
  }
  return undefined
}

/** The policy inputs as the SQLite stores hold them (config-sqlite: settings + catalog are the
 *  runtime truth; jsonc is import/export wire only). `undefined` = the stores are not seeded yet
 *  (no db / no tables / both empty — a pre-first-boot process), so the caller may fall back to
 *  the jsonc that is about to be imported. Sync read-only one-shots — this runs at layer init. */
export function readStorePolicy(dbFile: string): { readonly offline: boolean; readonly providerHosts: string[] } | undefined {
  const settings = readRowsSync(dbFile, "SELECT key, value FROM runtime_setting")
  const providers = readRowsSync(dbFile, "SELECT layers FROM catalog_provider")
  if ((settings === undefined || settings.length === 0) && (providers === undefined || providers.length === 0))
    return undefined
  const parseJson = (value: unknown): unknown => {
    if (typeof value !== "string") return value
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const offlineRow = settings?.find((row) => row.key === "offline")
  const hosts: string[] = []
  for (const row of providers ?? []) {
    const layers = parseJson(row.layers)
    if (!Array.isArray(layers)) continue
    for (const layer of layers) {
      const host = providerHost(layer)
      if (host) hosts.push(host)
    }
  }
  return { offline: offlineRow !== undefined && parseJson(offlineRow.value) === true, providerHosts: hosts }
}

export function loadPolicy(input: {
  configDir: string
  env?: Record<string, string | undefined>
  /** The instance database file; tests inject a temp db. Default: the real instance db. */
  dbFile?: string
}): Policy {
  const env = input.env ?? process.env
  // Source order: env (machine escape hatch) → the SQLite stores (the runtime truth since
  // config-sqlite) → the jsonc ONLY while the stores are unseeded (pre-first-boot, when the file
  // is what seedAll is about to import). A stale exported jsonc never overrides the stores.
  const store = readStorePolicy(input.dbFile ?? DatabasePath.path())
  const config = store === undefined ? readGlobalConfig(input.configDir) : undefined
  const fromConfig = (config as { offline?: unknown } | undefined)?.offline === true
  const enabled = truthy(env["NOVACLAW_OFFLINE"]) || (store !== undefined ? store.offline : fromConfig)
  if (!enabled) return disabledPolicy
  const hosts = store !== undefined ? store.providerHosts : providerHostsFromConfig(config)
  const allowedHosts = new Set([...hosts, ...parseAllowList(env["NOVACLAW_OFFLINE_ALLOW"])])
  return { enabled, allowedHosts }
}

// ── OFF-C (layer 9): process-level egress guard ─────────────────────────────────────────
//
// The model's own bash/curl/python can reach the WAN directly — layers 1-8 only bind OUR
// HttpClient. OFF-C wraps the child process environment so the shell's HTTP clients
// (curl, wget, pip, npm, git, most language stdlibs that honor *_PROXY) fail closed:
//   - HTTP(S)_PROXY point at a dead loopback sink (127.0.0.1:9), so any proxied request
//     connection-refuses instead of egressing;
//   - NO_PROXY carries loopback + the allowlisted hosts, so those (the local vLLM, a LAN
//     SearXNG/KB) bypass the sink and still work;
//   - a lowercase alias set (curl uses lowercase) mirrors each var.
// This is best-effort for the RAW/attended path: a determined static binary that ignores
// *_PROXY and opens raw sockets escapes it. That escape is CLOSED for confined (unattended)
// commands — Agent Jail P2 (agent-jail.ts) runs them in an empty network namespace where a raw
// socket also fails ("Network is unreachable"), the airgap-complete backstop this comment used
// to call "out of scope" (proof: tests/agent-jail-netns-smoke.sh). The env overlay stays as the
// portable common-case guard (curl/pip/npm/git) and the only guard where no netns applies.
// Loopback stays reachable through the overlay (the app talking to itself is not egress).

/** The unreachable sink every non-allowlisted request is pointed at. */
export const PROXY_SINK = "http://127.0.0.1:9"

/** NO_PROXY value: loopback forms + the allowlisted hosts (comma-separated). */
export function noProxyList(policy: Policy): string {
  return ["localhost", "127.0.0.1", "::1", ...[...policy.allowedHosts].sort()].join(",")
}

/**
 * Child-process env overlay enforcing OFF-C. Returns `undefined` when offline mode is off
 * (no-op — never touch the child env otherwise). Keys are set in BOTH cases (curl reads
 * lowercase; most others uppercase).
 */
export function egressEnv(policy: Policy): Record<string, string> | undefined {
  if (!policy.enabled) return undefined
  const noProxy = noProxyList(policy)
  return {
    HTTP_PROXY: PROXY_SINK,
    HTTPS_PROXY: PROXY_SINK,
    ALL_PROXY: PROXY_SINK,
    NO_PROXY: noProxy,
    http_proxy: PROXY_SINK,
    https_proxy: PROXY_SINK,
    all_proxy: PROXY_SINK,
    no_proxy: noProxy,
    // pip honors this; git honors http.proxy but also *_PROXY via curl.
    PIP_PROXY: PROXY_SINK,
  }
}

// ── The offline-layer manifest (the "N/9 layers active" indicator) ──────────────────────
export interface LayerStatus {
  readonly layer: number
  readonly name: string
  readonly active: boolean
  readonly detail?: string
}

/** Snapshot the 9-layer offline posture for the UI/status endpoint. */
export function layerManifest(policy: Policy): { readonly enabled: boolean; readonly active: number; readonly total: number; readonly layers: readonly LayerStatus[] } {
  const on = policy.enabled
  const layers: LayerStatus[] = [
    { layer: 1, name: "HttpClient chokepoint", active: on, detail: "shared Effect HttpClient (LLM, webfetch, probe, share)" },
    { layer: 2, name: "provider-host allowlist", active: on, detail: on ? `${policy.allowedHosts.size} host(s) + loopback` : undefined },
    { layer: 3, name: "MCP transport", active: on, detail: "MCP servers ride the chokepoint or their own Offline check" },
    { layer: 4, name: "OTLP telemetry", active: on, detail: "exporter checks OTEL endpoint against the allowlist" },
    { layer: 5, name: "share/sync egress", active: on, detail: "share URLs ride the chokepoint" },
    { layer: 6, name: "auto-update", active: on, detail: "update fetches ride the chokepoint" },
    { layer: 7, name: "LAN services", active: on, detail: "SearXNG/KB allowed as loopback/LAN hosts" },
    { layer: 8, name: "npm installs", active: on, detail: "package fetches fail closed (pre-provision or mirror)" },
    { layer: 9, name: "process egress guard", active: on, detail: on ? "child *_PROXY → dead sink; allowlist in NO_PROXY (confined commands: real deny-all netns, Agent Jail P2)" : "OFF-C" },
  ]
  return { enabled: on, active: on ? layers.length : 0, total: layers.length, layers }
}

export interface Interface {
  readonly policy: Policy
  readonly check: (url: string) => Verdict
  /** OFF-C: the child-process env overlay (undefined when offline mode is off). */
  readonly egressEnv: () => Record<string, string> | undefined
  /** The N/9 layer manifest for the status surface. */
  readonly manifest: () => ReturnType<typeof layerManifest>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Offline") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const policy = loadPolicy({ configDir: global.config })
    if (policy.enabled)
      yield* Effect.logInfo("offline mode ACTIVE — HTTP restricted to loopback + provider hosts", {
        allowedHosts: [...policy.allowedHosts],
      })
    return Service.of({
      policy,
      check: (url) => checkUrl(url, policy),
      egressEnv: () => egressEnv(policy),
      manifest: () => layerManifest(policy),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })

/** Wrap an HttpClient so every request passes the offline policy (fail-closed). */
export function guard(client: HttpClient.HttpClient, offline: Interface): HttpClient.HttpClient {
  return HttpClient.transform(client, (effect, request) => {
    const verdict = offline.check(request.url)
    if (verdict.allowed) return effect
    // Log every block server-side: consumers may wrap/flatten the typed error
    // (the LLM RequestExecutor keeps only the reason tag), so the log line is
    // where an operator reliably sees WHAT was refused and why.
    return Effect.logWarning("offline mode blocked outbound request", {
      url: request.url,
      host: verdict.host,
    }).pipe(Effect.andThen(
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.InvalidUrlError({ request, description: verdict.message }),
        }),
      ),
    ))
  })
}

export * as Offline from "./offline"
