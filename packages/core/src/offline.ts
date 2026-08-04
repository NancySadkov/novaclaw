// OFF-A — offline / airgap mode, layers 1–2: the HTTP-client allowlist chokepoint.
//
// When offline mode is ON, the shared Effect `HttpClient` (the single chokepoint the
// V2 LLM RequestExecutor, webfetch, probe, share, … all ride) refuses any host that
// is not (a) loopback or (b) a configured model-provider host. Fail-closed with a
// legible error naming the blocked host and how to allow it.
//
// Policy sources (a machine-level invariant, not per-request — read at layer init and re-read
// whenever a config write commits, never per request; see "The LIVE policy" below):
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
// The block error is an HttpClientError with an InvalidUrlError reason — the platform's reason
// union is closed, so a policy verdict has to borrow one of its arms. ⚠️ The tag alone is
// AMBIGUOUS: the platform raises `InvalidUrlError` for a genuinely malformed URL too, and calling
// a deliberate airgap block "a broken endpoint URL" (or vice versa) is v0.2.0 ruling 2's *a fault
// is never described falsely*. So the verdict declares itself in the `cause` as an `EgressBlocked`
// marker, which `packages/llm`'s RequestExecutor lifts into its own `OfflineBlockedReason` — a
// distinct arm all the way to the user's screen, non-retryable by construction rather than by a
// `kind`-string special case in `provider-retry.ts`.
import fs from "fs"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientError } from "effect/unstable/http"
import { EgressBlocked } from "@novaclaw/llm"
import { Log } from "@novaclaw/schema/log"
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

const normalizeHost = (host: string) =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")

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

export type Verdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly host: string; readonly message: string }

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
export function readStorePolicy(
  dbFile: string,
): { readonly offline: boolean; readonly providerHosts: string[] } | undefined {
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

/** Everything `loadPolicy` reads. */
export interface PolicySource {
  readonly configDir: string
  readonly env?: Record<string, string | undefined>
  /** The instance database file; tests inject a temp db. Default: the real instance db. */
  readonly dbFile?: string
}

export function loadPolicy(input: PolicySource): Policy {
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

// ── The LIVE policy (v0.2.0-prep A3 — "a settings change is not a reboot") ───────────────
//
// The policy used to be computed ONCE inside `layer` and captured by `check`/`egressEnv`/
// `manifest`. Flipping airgap ON in Settings therefore blocked NOTHING until the process was
// restarted — while `/shell/offline`, which re-reads the same sources on every request, honestly
// reported 9/9 layers active. A guard that is off while the status surface says it is on is not a
// latency wart; it is v0.2.0 ruling 3's *a fault is never described falsely*.
//
// The ref is MODULE-level, not layer-level, deliberately:
//   · every input is process-global — the env, the instance SQLite file (`Flag.NOVACLAW_DB` is
//     read once at module load), and the global config dir (`Global.make()` resolves it once);
//   · nothing guarantees ONE instance per process. This comment used to assert that a serve
//     process demonstrably built the layer twice (the compiled `httpClient` node plus the bare
//     `Offline.layer` `server.ts` handed the messenger stack). ⚠️ That is not what happens on
//     effect@4.0.0-beta.83 — MEASURED 2026-07-28 with `serviceBuilds()` over the real serve graph:
//     both wrappings memoize to the SAME build, because what Effect keys on is this module-level
//     layer's reference, not the `Layer.provide` wrapper around it. So the count was one, by
//     coincidence of construction. It stops being one the moment a second consumer builds Offline
//     from a *different* layer object (`layerWith`, a mock, a fresh `Layer.effect`) — which tests
//     and the location graphs do routinely — and a per-instance cache would then leave whichever
//     instance did not handle the write stale: the same bug, one level down. Module-level is the
//     choice that does not depend on the memoization coincidence holding.
// One ref means every reader — the HttpClient chokepoint, `bash`/`js` egress env, websearch, the
// messenger gateway — flips together, on their next call.

let live: { readonly source: PolicySource; readonly policy: Policy } | undefined

/** Load the policy from `source` and publish it process-wide. Called when the layer is built. */
function installPolicy(source: PolicySource): Policy {
  const policy = loadPolicy(source)
  live = { source, policy }
  return policy
}

/**
 * Re-read the policy from the sources it was installed with, and publish the result.
 *
 * Called from `ConfigStoreWrite.apply` — the ONE place a config write commits — so a Settings
 * toggle takes effect on the next call instead of the next boot. A plain function rather than a
 * service member because the callers that need it have no `Offline.Service` in context: the
 * compiled `app` graph provides Offline *into* `httpClient`, which does not re-export it, so the
 * HTTP config handlers could not resolve it at all.
 *
 * A no-op before any layer has installed a source — nothing is guarding yet, so there is nothing
 * to refresh, and no I/O is done to discover that.
 */
export function reload(): Policy {
  return live === undefined ? disabledPolicy : installPolicy(live.source)
}

/** The live policy — `disabledPolicy` until a layer installs one (nothing is guarding). */
export function currentPolicy(): Policy {
  return live?.policy ?? disabledPolicy
}

/** Tests only: forget the installed source so one file's temp db cannot leak into the next. */
export function resetPolicy(): void {
  live = undefined
}

// How many times THIS LAYER has been built in this process. Not a policy fact — a GRAPH fact, and
// the only one that is observable at runtime: a duplicate Offline in the composition root compiles
// green, boots green, and answers every request correctly (the ref above is process-wide), so
// nothing but a count can tell you it happened. It is exported so the invariant "a serve process
// builds Offline exactly once" can be asserted instead of reasoned about.
// Deliberately NOT reset by `resetPolicy` and NOT incremented by `reload` — it counts layer builds,
// not policy installs, so a test can bracket a graph build and read the delta.
let builds = 0

/** Number of times the Offline layer has been built in this process (see `builds`). */
export function serviceBuilds(): number {
  return builds
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
export function layerManifest(policy: Policy): {
  readonly enabled: boolean
  readonly active: number
  readonly total: number
  readonly layers: readonly LayerStatus[]
} {
  const on = policy.enabled
  const layers: LayerStatus[] = [
    {
      layer: 1,
      name: "HttpClient chokepoint",
      active: on,
      detail: "shared Effect HttpClient (LLM, webfetch, probe, share)",
    },
    {
      layer: 2,
      name: "provider-host allowlist",
      active: on,
      detail: on ? `${policy.allowedHosts.size} host(s) + loopback` : undefined,
    },
    {
      layer: 3,
      name: "MCP transport",
      active: on,
      detail: "MCP servers ride the chokepoint or their own Offline check",
    },
    { layer: 4, name: "OTLP telemetry", active: on, detail: "exporter checks OTEL endpoint against the allowlist" },
    { layer: 5, name: "share/sync egress", active: on, detail: "share URLs ride the chokepoint" },
    { layer: 6, name: "auto-update", active: on, detail: "update fetches ride the chokepoint" },
    { layer: 7, name: "LAN services", active: on, detail: "SearXNG/KB allowed as loopback/LAN hosts" },
    { layer: 8, name: "npm installs", active: on, detail: "package fetches fail closed (pre-provision or mirror)" },
    {
      layer: 9,
      name: "process egress guard",
      active: on,
      detail: on
        ? "child *_PROXY → dead sink; allowlist in NO_PROXY (confined commands: real deny-all netns, Agent Jail P2)"
        : "OFF-C",
    },
  ]
  return { enabled: on, active: on ? layers.length : 0, total: layers.length, layers }
}

export interface Interface {
  /** The LIVE policy: a getter over the process-wide ref, so a consumer that resolved this service
   *  once at boot (the messenger gateway, websearch, the bash/js tools) follows a reload without
   *  re-resolving anything. Stays a VALUE member — turning it into a function would be a breaking
   *  change across four modules for no gain. */
  readonly policy: Policy
  readonly check: (url: string) => Verdict
  /** OFF-C: the child-process env overlay (undefined when offline mode is off). */
  readonly egressEnv: () => Record<string, string> | undefined
  /** The N/9 layer manifest for the status surface. */
  readonly manifest: () => ReturnType<typeof layerManifest>
  // No `reload` member, deliberately. Refreshing is a MODULE function (`Offline.reload`), because
  // the one caller that needs it — the config write path — has no `Offline.Service` in context,
  // and because a service holder never needs it: every member above reads the live ref already.
  // (A non-effectful member would also be REQUIRED, not optional, in `Layer.mock`'s
  // `PartialEffectful`, so adding one would break every existing Offline mock for nothing.)
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Offline") {}

const makeService = (source: PolicySource) =>
  Effect.gen(function* () {
    builds++
    const policy = installPolicy(source)
    if (policy.enabled)
      yield* Log.event("offline.policy.activate", {
        "offline.policy.hosts": JSON.stringify([...policy.allowedHosts]),
      })
    return Service.of({
      // A getter over the live ref, NOT the policy captured above: every method below reads the
      // same ref, so a `ConfigStoreWrite.apply` that flips `offline` engages this service's guard
      // on its next call rather than at the next restart.
      get policy() {
        return currentPolicy()
      },
      check: (url) => checkUrl(url, currentPolicy()),
      egressEnv: () => egressEnv(currentPolicy()),
      manifest: () => layerManifest(currentPolicy()),
    })
  })

/** Build over an explicit policy source. Tests inject a temp config dir + db file: `NOVACLAW_DB`
 *  is read once at module load, so a test cannot move the real one out from under `layer`. */
export const layerWith = (source: PolicySource) => Layer.effect(Service, makeService(source))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    return yield* makeService({ configDir: global.config })
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
    return Log.event("offline.request.blocked", {
      "offline.request.url": request.url,
      "offline.request.host": verdict.host,
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.InvalidUrlError({
              request,
              description: verdict.message,
              // The typed declaration — see the header note. `description` stays for every reader
              // that only knows the platform shape (and for records already on disk).
              cause: new EgressBlocked(verdict.host, verdict.message),
            }),
          }),
        ),
      ),
    )
  })
}

export * as Offline from "./offline"
