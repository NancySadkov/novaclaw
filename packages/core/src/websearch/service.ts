export * as WebSearch from "./service"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Offline } from "../offline"
import { SettingsConfigStore } from "../settings-config-store"
import { WebGovernor } from "../web/governor"
import { WebSearchEngine } from "./engine"
import { CalloutPolicy } from "../callout-policy"

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
//
// ── WHY SEARCH RIDES `webfetch`'s GOVERNOR RATHER THAN OWNING A POLICY (2026-07-30) ──────────────
//
// Read this next to `tool/webfetch.ts`'s `governor.guard` call: the two halves of the web surface are
// governed by ONE machine, on purpose. Search shipped ungoverned — concurrent, unpaced, uncapped, against
// DuckDuckGo's HTML scraping endpoint, i.e. the single surface most likely to throttle and then block the
// USER'S ip. It said so itself ("Free engines throttle; try again shortly"), which is ruling 2's *a fault
// is never described falsely* pointed the other way: text describing a condition the code made no attempt
// to prevent. Worse, `config.ts`'s `web_search.throttle` block and the shipped **Traffic limits** panel on
// this very settings page told the user those limits "apply to every web read — searches and articles
// alike". They did not. Wiring the governor is what makes two already-shipped promises true.
//
// It is the same governor and not a sibling policy because the thing being protected is one host's
// patience with one IP: a search of `en.wikipedia.org` and a `webfetch` of an article there are the same
// server read by the same person, so they must share one budget and one queue (design principle 9's "one
// hand", which the messenger governor applies across every transport for the same reason).
//
// ⚠️ Three of the governor's rules were checked against a metasearch FAN-OUT before adopting them, because
// a governor that is wrong for search would be worse than none — the refusal text would then describe a
// fault that isn't real:
//   · **Loop detection is per-URL, and for search that IS a per-QUERY dedupe** — every engine request URL
//     embeds the query, so distinct searches are distinct keys (never a false loop) while the same query
//     repeated past `sameUrlLimit` is refused, which is what a stuck agent actually does. Only the WORDING
//     needed a search-shaped variant; hence `loopReason` below.
//   · **One-request-in-flight-per-host does not serialize the fan-out** — the fan-out is ACROSS hosts (one
//     request per engine per search), so the per-host semaphores are all entered at once. What it does
//     serialize is two concurrent searches of the same engine, which is precisely the swarm to avoid.
//   · **The daily cap is meaningful per engine host** — and because it is per host, DuckDuckGo hitting its
//     cap leaves Wikipedia working, so the search DEGRADES through the existing partial-result path
//     instead of dying.
//
// The one axis where search genuinely does diverge from `webfetch` is OFFLINE (rule 1 above), and that
// divergence is FORCED: these engines call raw `fetch` rather than the shared `HttpClient` node, so the
// offline chokepoint cannot see them. A traffic-policy divergence would have been a CHOSEN one, with
// nothing forcing it — which is why it was a bug and not a design.

export interface SearchOutcome {
  readonly ok: boolean
  readonly results: readonly WebSearchEngine.Result[]
  /** Present when ok is false — plain words, and actionable (the JH floor). */
  readonly reason?: string
  /** Engines that failed while others worked, so a partial answer is never silently partial. */
  readonly degraded?: readonly string[]
}

export interface Interface {
  readonly search: (
    query: string,
    options?: {
      readonly limit?: number
      /**
       * Whose search this is. The traffic governor's loop guard is per session, so a fresh session may
       * legitimately re-run a query an earlier one exhausted; omitting it would pool every session's
       * queries into one counter that never resets for the life of the process.
       */
      readonly sessionID?: string
    },
  ) => Effect.Effect<SearchOutcome>
  /** What search would do right now, for the settings surface and for honest tool descriptions. */
  readonly describe: () => Effect.Effect<{
    readonly mode: "airgapped" | "searxng" | "builtin"
    readonly detail: string
  }>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/WebSearch") {}

const DEFAULT_LIMIT = 8
const DEFAULT_TIMEOUT_MS = 8_000

/**
 * The traffic governor's loop refusal, in SEARCH's words. The default names the URL, which is right for
 * `webfetch` — the model picked that URL. Here the model picked a QUERY and has never heard of
 * `html.duckduckgo.com`, so naming the endpoint would both confuse it and suggest `webfetch`ing the
 * scraper. What a looping searcher needs told is: the answer is already above you, or use other words.
 */
export const loopReason = (query: string, seenCount: number): string =>
  `Refusing to search for "${query}" again — that exact query has already run ${seenCount} times in this ` +
  `session, which is a loop rather than research. Its results are already in the transcript: re-read those, ` +
  `search DIFFERENT words, or open one of the pages you already found with webfetch.`

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
  const timeout =
    typeof value["timeoutMs"] === "number" && Number.isFinite(value["timeoutMs"]) ? value["timeoutMs"] : undefined
  return {
    ...(url.length === 0 ? {} : { searxngUrl: url }),
    ...(disabled === undefined ? {} : { disabledEngines: disabled }),
    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
  }
}

/** Build the engine set for one call. Pure given the settings, so the precedence is unit-testable. */
export const resolveEngines = (
  fetchImpl: WebSearchEngine.FetchLike,
  settings: Settings,
): readonly WebSearchEngine.Engine[] => {
  if (settings.searxngUrl !== undefined) return [WebSearchEngine.searxng(fetchImpl, settings.searxngUrl)]
  const disabled = new Set(settings.disabledEngines ?? [])
  return [WebSearchEngine.duckduckgo(fetchImpl), WebSearchEngine.wikipedia(fetchImpl)].filter(
    (engine) => !disabled.has(engine.id),
  )
}

export const layerWith = (fetchImpl: WebSearchEngine.FetchLike) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const offline = yield* Offline.Service
      const settingsStore = yield* SettingsConfigStore.Service
      const governor = yield* WebGovernor.Service

      /**
       * One search's leg of the shared governor (see the header). Built per call because it closes over
       * the two things only this call knows: the QUERY, which is how a loop refusal must name itself, and
       * the SESSION, which is what the loop counter is scoped to. A `WebBudgetError` is translated into
       * the engines' own `SearchError` so a governor refusal travels the SAME best-effort path an engine
       * failure does — one capped engine degrades the search and is named, it never fails the whole call.
       */
      const gateFor =
        (query: string, sessionID?: string): WebSearchEngine.Gate =>
        (url, request) =>
          governor
            .guard({
              url,
              ...(sessionID === undefined ? {} : { sessionID }),
              loopReason: (seenCount) => loopReason(query, seenCount),
              fetch: request,
            })
            .pipe(
              Effect.mapError((error) =>
                error instanceof WebGovernor.WebBudgetError
                  ? new WebSearchEngine.SearchError({ reason: error.message })
                  : error,
              ),
            )

      const currentSettings = Effect.gen(function* () {
        const all = yield* settingsStore.all().pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>))
        return readSettings(all["web_search"])
      })

      const describe = () =>
        Effect.gen(function* () {
          if (offline.policy.enabled)
            return { mode: "airgapped" as const, detail: "Web search is off while NovaClaw is offline or airgapped." }
          const settings = yield* currentSettings
          if (settings.searxngUrl !== undefined)
            return { mode: "searxng" as const, detail: `Your own SearXNG at ${settings.searxngUrl}.` }
          const engines = resolveEngines(fetchImpl, settings).map((engine) => engine.name)
          return {
            mode: "builtin" as const,
            detail: `Built-in search (${engines.join(", ") || "no engines enabled"}).`,
          }
        })

      const search: Interface["search"] = (query, options) =>
        Effect.gen(function* () {
          const trimmed = query.trim()
          if (trimmed.length === 0)
            return { ok: false, results: [], reason: "Give me something to search for." } satisfies SearchOutcome
          // Rule 1 — the airgap gate, checked at call time (offline can be flipped while running).
          if (offline.policy.enabled)
            return {
              ok: false,
              results: [],
              reason:
                "Web search is off because NovaClaw is in offline/airgap mode — nothing leaves this machine. Turn offline mode off to search.",
            } satisfies SearchOutcome
          const settings = yield* currentSettings
          const engines = resolveEngines(fetchImpl, settings)
          if (engines.length === 0)
            return {
              ok: false,
              results: [],
              reason: "Every search engine is disabled in settings.",
            } satisfies SearchOutcome
          const limit = Math.max(1, Math.min(25, Math.floor(options?.limit ?? DEFAULT_LIMIT)))
          const policy = CalloutPolicy.websearch(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS, engines.length)
          const searchOptions = {
            limit,
            timeoutMs: policy.timeoutMs,
            gate: gateFor(trimmed, options?.sessionID),
          }

          // Engines run CONCURRENTLY and independently: one throttled scraper must not cost the
          // user the results the others found, and the slowest one bounds the wait, not the sum.
          const settled = yield* Effect.all(
            engines.map((engine) =>
              engine.search(trimmed, searchOptions).pipe(
                Effect.map((results) => ({ engine, results, failure: undefined as string | undefined })),
                Effect.catch((error) =>
                  Effect.succeed({ engine, results: [] as readonly WebSearchEngine.Result[], failure: error.reason }),
                ),
              ),
            ),
            { concurrency: policy.maxConcurrency },
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

export const node = makeGlobalNode({
  service: Service,
  layer,
  // ⚠️ `WebGovernor.node` is load-bearing, not decoration: drop it and every search goes out unpaced,
  // uncapped and unlooped again while the Traffic-limits settings panel keeps claiming otherwise.
  // `test/tool-websearch.test.ts` pins its presence here for exactly that reason.
  deps: [Offline.node, SettingsConfigStore.node, WebGovernor.node],
})
