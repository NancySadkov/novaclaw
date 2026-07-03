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

export interface Interface {
  readonly policy: Policy
  readonly check: (url: string) => Verdict
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
    return Service.of({ policy, check: (url) => checkUrl(url, policy) })
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
