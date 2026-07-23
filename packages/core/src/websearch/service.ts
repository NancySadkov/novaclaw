export * as WebSearch from "./service"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Offline } from "../offline"
import { SettingsConfigStore } from "../settings-config-store"
import { WebSearchEngine } from "./engine"

// The web-search service: ONE entry point the agent's tool calls, which decides at CALL TIME what
// is actually available. Three rules, in order:
//
//   1. AIRGAP WINS. Offline/OFF-C mode force-disables it — the built-in reaches WAN engines by
//      definition, and "the data plane never egresses" is not negotiable for a convenience. A
//      LAN SearXNG is still refused here: the allowlist decision belongs to the offline policy,
//      not to a search tool arguing its own case.
//   2. A CONFIGURED SearXNG WINS over the built-in. The built-in is the floor for people who have
//      nothing, never a replacement for the instance a power user chose.
//   3. Otherwise the built-in engines run, in parallel, and their results are merged.
//
// Everything is read from the LIVE settings store per call (the kb/messenger precedent), so an
// agent can repair a broken engine or point at a new SearXNG through config with no restart —
// the self-healing law, applied to the thing most likely to break: someone else's endpoint.

export interface SearchOutcome {
  readonly ok: boolean
  readonly results: readonly WebSearchEngine.Result[]
  /** Present when ok is false — plain words, and actionable (the JH floor). */
  readonly reason?: string
  /** Engines that failed while others worked, so a partial answer is never silently partial. */
  readonly degraded?: readonly string[]
}

export interface Interface {
  readonly search: (query: string, options?: { readonly limit?: number }) => Effect.Effect<SearchOutcome>
  /** What search would do right now, for the settings surface and for honest tool descriptions. */
  readonly describe: () => Effect.Effect<{ readonly mode: "airgapped" | "searxng" | "builtin"; readonly detail: string }>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/WebSearch") {}

const DEFAULT_LIMIT = 8
const DEFAULT_TIMEOUT_MS = 8_000

/** The `web_search` settings block, all optional — an instance with no config still searches. */
export interface Settings {
  /** A SearXNG base URL; when set it REPLACES the built-ins. */
  readonly searxngUrl?: string
  /** Turn built-in engines off by id (an engine that starts misbehaving can be disabled live). */
  readonly disabledEngines?: readonly string[]
  readonly timeoutMs?: number
}

export const readSettings = (raw: unknown): Settings => {
  const value = (raw ?? {}) as Record<string, unknown>
  const url = typeof value["searxngUrl"] === "string" ? value["searxngUrl"].trim() : ""
  const disabled = Array.isArray(value["disabledEngines"])
    ? value["disabledEngines"].filter((entry): entry is string => typeof entry === "string")
    : undefined
  const timeout = typeof value["timeoutMs"] === "number" && Number.isFinite(value["timeoutMs"]) ? value["timeoutMs"] : undefined
  return {
    ...(url.length === 0 ? {} : { searxngUrl: url }),
    ...(disabled === undefined ? {} : { disabledEngines: disabled }),
    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
  }
}

/** Build the engine set for one call. Pure given the settings, so the precedence is unit-testable. */
export const resolveEngines = (fetchImpl: WebSearchEngine.FetchLike, settings: Settings): readonly WebSearchEngine.Engine[] => {
  if (settings.searxngUrl !== undefined) return [WebSearchEngine.searxng(fetchImpl, settings.searxngUrl)]
  const disabled = new Set(settings.disabledEngines ?? [])
  return [WebSearchEngine.duckduckgo(fetchImpl), WebSearchEngine.wikipedia(fetchImpl)].filter((engine) => !disabled.has(engine.id))
}

export const layerWith = (fetchImpl: WebSearchEngine.FetchLike) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const offline = yield* Offline.Service
      const settingsStore = yield* SettingsConfigStore.Service

      const currentSettings = Effect.gen(function* () {
        const all = yield* settingsStore.all().pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>))
        return readSettings(all["web_search"])
      })

      const describe = () =>
        Effect.gen(function* () {
          if (offline.policy.enabled)
            return { mode: "airgapped" as const, detail: "Web search is off while NovaClaw is offline or airgapped." }
          const settings = yield* currentSettings
          if (settings.searxngUrl !== undefined) return { mode: "searxng" as const, detail: `Your own SearXNG at ${settings.searxngUrl}.` }
          const engines = resolveEngines(fetchImpl, settings).map((engine) => engine.name)
          return { mode: "builtin" as const, detail: `Built-in search (${engines.join(", ") || "no engines enabled"}).` }
        })

      const search: Interface["search"] = (query, options) =>
        Effect.gen(function* () {
          const trimmed = query.trim()
          if (trimmed.length === 0) return { ok: false, results: [], reason: "Give me something to search for." } satisfies SearchOutcome
          // Rule 1 — the airgap gate, checked at call time (offline can be flipped while running).
          if (offline.policy.enabled)
            return {
              ok: false,
              results: [],
              reason: "Web search is off because NovaClaw is in offline/airgap mode — nothing leaves this machine. Turn offline mode off to search.",
            } satisfies SearchOutcome
          const settings = yield* currentSettings
          const engines = resolveEngines(fetchImpl, settings)
          if (engines.length === 0)
            return { ok: false, results: [], reason: "Every search engine is disabled in settings." } satisfies SearchOutcome
          const limit = Math.max(1, Math.min(25, Math.floor(options?.limit ?? DEFAULT_LIMIT)))
          const searchOptions = { limit, timeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS }

          // Engines run CONCURRENTLY and independently: one throttled scraper must not cost the
          // user the results the others found, and the slowest one bounds the wait, not the sum.
          const settled = yield* Effect.all(
            engines.map((engine) =>
              engine.search(trimmed, searchOptions).pipe(
                Effect.map((results) => ({ engine, results, failure: undefined as string | undefined })),
                Effect.catch((error) => Effect.succeed({ engine, results: [] as readonly WebSearchEngine.Result[], failure: error.reason })),
              ),
            ),
            { concurrency: "unbounded" },
          )

          const worked = settled.filter((entry) => entry.failure === undefined)
          const failed = settled.filter((entry) => entry.failure !== undefined)
          const merged = WebSearchEngine.mergeResults(
            worked.map((entry) => entry.results),
            limit,
          )
          if (merged.length === 0) {
            // An empty list reads as "the web has nothing", which is a lie when every engine
            // refused us. Say which, and why, so the agent can try different words or tell the user.
            if (failed.length === settled.length)
              return {
                ok: false,
                results: [],
                reason: `No search engine answered (${failed.map((entry) => `${entry.engine.name}: ${entry.failure}`).join("; ")}). Free engines throttle; try again shortly, or set your own SearXNG in settings.`,
              } satisfies SearchOutcome
            return { ok: true, results: [], reason: "No results found for that query." } satisfies SearchOutcome
          }
          return {
            ok: true,
            results: merged,
            ...(failed.length === 0 ? {} : { degraded: failed.map((entry) => entry.engine.name) }),
          } satisfies SearchOutcome
        })

      return Service.of({ search, describe })
    }),
  )

export const layer = layerWith((url, init) => fetch(url, init))

export const node = makeGlobalNode({ service: Service, layer, deps: [Offline.node, SettingsConfigStore.node] })
