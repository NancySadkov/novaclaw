// OFF-A — offline / airgap mode, layers 1–2: the HTTP-client allowlist chokepoint.
//
// When offline mode is ON, the shared Effect `HttpClient` (the single chokepoint the
// V2 LLM RequestExecutor, webfetch, probe, share, … all ride) refuses any host that
// is not (a) loopback or (b) a configured model-provider host. Fail-closed with a
// legible error naming the blocked host and how to allow it.
//
// Policy sources (snapshot at layer init — a machine-level invariant, not per-request):
//   - `NOVACLAW_OFFLINE` env ("true"/"1") OR `offline: true` in the GLOBAL config file.
//   - allowlist = hosts of `provider.*.options.baseURL` from the GLOBAL config
//     (project-scoped providers are not visible to this global layer — in airgap
//     mode, declare the provider globally or use the env escape hatch), plus
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

/** Hostnames of every `provider.*.options.baseURL` in a (decoded-or-raw) config object. */
export function providerHostsFromConfig(config: unknown): string[] {
  const providers = (config as { provider?: Record<string, unknown> } | undefined)?.provider
  if (!providers || typeof providers !== "object") return []
  const hosts: string[] = []
  for (const entry of Object.values(providers)) {
    const baseURL = (entry as { options?: { baseURL?: unknown } } | undefined)?.options?.baseURL
    if (typeof baseURL !== "string") continue
    const host = hostFromUrl(baseURL)
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
      `To allow it: add the provider to the GLOBAL novaclaw.jsonc, extend NOVACLAW_OFFLINE_ALLOW ` +
      `(comma-separated hosts), or turn offline mode off.`,
  }
}

const truthy = (value: string | undefined) => value === "true" || value === "1"

const CONFIG_NAMES = ["config.json", "novaclaw.json", "novaclaw.jsonc"]

/** Read the GLOBAL config file (first of the known names that parses). Sync + tolerant. */
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

export function loadPolicy(input: { configDir: string; env?: Record<string, string | undefined> }): Policy {
  const env = input.env ?? process.env
  const config = readGlobalConfig(input.configDir)
  const enabled = truthy(env["NOVACLAW_OFFLINE"]) || (config as { offline?: unknown } | undefined)?.offline === true
  if (!enabled) return disabledPolicy
  const allowedHosts = new Set([...providerHostsFromConfig(config), ...parseAllowList(env["NOVACLAW_OFFLINE_ALLOW"])])
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
// This is best-effort, not a jail: a determined static binary that ignores *_PROXY and
// opens raw sockets escapes it (a real network namespace / firewall is the OS-level
// backstop, per-OS, out of scope). It stops the common case — curl/pip/npm/git — cheaply
// and portably. Loopback stays reachable (the app talking to itself is not egress).

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
    { layer: 9, name: "process egress guard", active: on, detail: on ? "child *_PROXY → dead sink; allowlist in NO_PROXY" : "OFF-C" },
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
