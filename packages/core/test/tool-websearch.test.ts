import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { WebGovernor } from "@novaclaw/core/web/governor"
import { WebSearchEngine } from "@novaclaw/core/websearch/engine"
import { WebSearch } from "@novaclaw/core/websearch/service"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionV2 } from "@novaclaw/core/session"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { WebSearchTool } from "@novaclaw/core/tool/websearch"
import { Offline } from "@novaclaw/core/offline"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { it, testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

// Built-in web search (todo.md → "a fallback so it just works for lay users"). The test that lived
// here covered the inherited Exa/Parallel product backends, which this replaced: paid APIs, branded
// providers in the kernel, and no working search at all on a fresh instance.
//
// What matters now: the airgap gate holds, a configured SearXNG beats the built-ins, one dead
// engine never costs the user the others' results, and an all-engines-failed search says so rather
// than returning an empty list that reads like "the web has nothing".

const DDG_HTML = `
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs&amp;rut=x">Bun &amp; docs</a>
  <a class="result__snippet" href="x">All about <b>Bun</b>, the runtime.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="https://example.com/two">Second result</a>
  <a class="result__snippet" href="x">Another page.</a>
</div>`

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

describe("WebSearchEngine parsing", () => {
  test("DuckDuckGo results survive redirect wrapping and HTML entities", () => {
    const results = WebSearchEngine.parseDuckDuckGo(DDG_HTML, 10)
    expect(results).toHaveLength(2)
    // The real URL is inside the redirect, not the redirect itself.
    expect(results[0]?.url).toBe("https://bun.sh/docs")
    expect(results[0]?.title).toBe("Bun & docs")
    expect(results[0]?.snippet).toBe("All about Bun, the runtime.")
    expect(results[1]?.url).toBe("https://example.com/two")
  })

  test("a layout change degrades to fewer results, never to a crash", () => {
    expect(WebSearchEngine.parseDuckDuckGo("<html><body>nothing familiar</body></html>", 10)).toEqual([])
  })

  // ⚠️ Full-text search, NOT opensearch: opensearch matches title prefixes, so "bun javascript
  // runtime" returned zero results against the live API. Caught by probing, not by reading docs.
  test("Wikipedia full-text results decode, with the highlight markup stripped", () => {
    const results = WebSearchEngine.parseWikipedia(
      {
        query: {
          search: [
            { title: "Bun (software)", snippet: 'A <span class="searchmatch">JavaScript</span> runtime' },
            { title: "Bun" },
          ],
        },
      },
      10,
    )
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: "Bun (software)",
      url: "https://en.wikipedia.org/wiki/Bun%20(software)".replace("%20", "_"),
      snippet: "A JavaScript runtime",
      engine: "wikipedia",
    })
    expect(WebSearchEngine.parseWikipedia({ not: "the shape" }, 10)).toEqual([])
  })

  test("a SearXNG JSON body decodes", () => {
    const results = WebSearchEngine.parseSearxng(
      { results: [{ title: "T", url: "https://x.test/", content: "S" }] },
      10,
    )
    expect(results[0]).toEqual({ title: "T", url: "https://x.test/", snippet: "S", engine: "searxng" })
  })

  test("the same page at different addresses is one result", () => {
    const canonical = WebSearchEngine.canonicalUrl("https://www.Example.com/a/?utm_source=x#frag")
    expect(canonical).toBe(WebSearchEngine.canonicalUrl("https://example.com/a"))
    expect(canonical).not.toBe(WebSearchEngine.canonicalUrl("https://example.com/b"))
  })

  // Agreement between independent engines is the only quality signal available without crawling
  // anything ourselves — that IS what a metasearch engine is for.
  test("merging ranks a page two engines agree on above one engine's top hit", () => {
    const merged = WebSearchEngine.mergeResults(
      [
        [
          { title: "Only A", url: "https://a.test/", engine: "duckduckgo" },
          { title: "Both", url: "https://both.test/", engine: "duckduckgo" },
        ],
        [{ title: "Both", url: "https://both.test/", snippet: "a fuller description", engine: "wikipedia" }],
      ],
      5,
    )
    expect(merged[0]?.url).toBe("https://both.test/")
    expect(merged[0]?.engine).toBe("duckduckgo+wikipedia") // provenance survives the merge
    expect(merged[0]?.snippet).toBe("a fuller description") // the fullest description wins
    expect(merged).toHaveLength(2)
  })
})

describe("WebSearch settings + precedence", () => {
  const unusedFetch: WebSearchEngine.FetchLike = () => Promise.reject(new Error("unused"))

  test("a configured SearXNG REPLACES the built-ins (the user's instance wins)", () => {
    expect(
      WebSearch.resolveEngines(unusedFetch, { searxngUrl: "https://searx.example" }).map((engine) => engine.id),
    ).toEqual(["searxng"])
  })

  test("with nothing configured the built-ins run — and one can be disabled live", () => {
    expect(WebSearch.resolveEngines(unusedFetch, {}).map((engine) => engine.id)).toEqual(["duckduckgo", "wikipedia"])
    expect(
      WebSearch.resolveEngines(unusedFetch, { disabledEngines: ["duckduckgo"] }).map((engine) => engine.id),
    ).toEqual(["wikipedia"])
  })

  test("junk settings decode to defaults rather than throwing", () => {
    expect(WebSearch.readSettings(undefined)).toEqual({})
    expect(WebSearch.readSettings({ searxngUrl: "  " })).toEqual({})
    expect(WebSearch.readSettings({ searxngUrl: "https://s.test", timeoutMs: 500 })).toEqual({
      searxngUrl: "https://s.test",
      timeoutMs: 500,
    })
  })
})

const settingsMock = (settings: Record<string, unknown>) =>
  Layer.mock(SettingsConfigStore.Service, {
    all: () => Effect.succeed(settings),
    set: () => Effect.void,
    remove: () => Effect.void,
    isEmpty: () => Effect.succeed(Object.keys(settings).length === 0),
  } as never)

const offlineMock = (enabled: boolean) =>
  Layer.mock(Offline.Service)({
    policy: { enabled, allowedHosts: new Set<string>() },
    check: () => ({ allowed: true }) as const,
    egressEnv: () => undefined,
    manifest: () => ({ enabled, active: enabled ? 9 : 0, total: 9, layers: [] }),
  })

/** A pass-through governor: these tests are about ENGINE precedence, not traffic. The block at the bottom
 *  of this file exercises the real one, over a real budget table. */
const openGovernor = Layer.succeed(WebGovernor.Service, WebGovernor.Service.of({ guard: (input) => input.fetch }))

const service = (
  fetchImpl: WebSearchEngine.FetchLike,
  options?: { offline?: boolean; settings?: Record<string, unknown> },
) =>
  WebSearch.layerWith(fetchImpl).pipe(
    Layer.provide(offlineMock(options?.offline ?? false)),
    Layer.provide(settingsMock(options?.settings ?? {})),
    Layer.provide(openGovernor),
  )

describe("WebSearch service", () => {
  it.live("merges what the engines returned, and names one that dropped out", () =>
    Effect.gen(function* () {
      const search = yield* WebSearch.Service
      const outcome = yield* search.search("bun runtime")
      expect(outcome.ok).toBe(true)
      expect(outcome.results.map((result) => result.url)).toContain("https://bun.sh/docs")
      // Wikipedia failed here; DuckDuckGo's results still came back, flagged as partial.
      expect(outcome.degraded).toEqual(["Wikipedia"])
    }).pipe(
      Effect.provide(
        service(async (url) => {
          if (url.includes("wikipedia")) throw new Error("429 Too Many Requests")
          return new Response(DDG_HTML, { status: 200 })
        }),
      ),
    ),
  )

  // An empty list reads as "the web has nothing", which is a lie when every engine refused us.
  it.live("says WHY when every engine fails, instead of returning nothing", () =>
    Effect.gen(function* () {
      const search = yield* WebSearch.Service
      const outcome = yield* search.search("anything")
      expect(outcome.ok).toBe(false)
      expect(outcome.reason).toContain("No search engine answered")
      expect(outcome.reason).toContain("DuckDuckGo")
      expect(outcome.reason).toContain("SearXNG") // the way out is named
    }).pipe(Effect.provide(service(async () => new Response("nope", { status: 503 })))),
  )

  it.live("AIRGAP refuses before any request leaves the machine", () =>
    Effect.gen(function* () {
      const reached: string[] = []
      const outcome = yield* Effect.gen(function* () {
        const search = yield* WebSearch.Service
        const result = yield* search.search("anything")
        const described = yield* search.describe()
        return { result, described }
      }).pipe(
        Effect.provide(
          service(
            async (url) => {
              reached.push(url)
              return new Response("", { status: 200 })
            },
            { offline: true },
          ),
        ),
      )
      expect(outcome.result.ok).toBe(false)
      expect(outcome.result.reason).toContain("offline")
      expect(reached).toEqual([]) // the gate is before the socket, not after it
      expect(outcome.described.mode).toBe("airgapped")
    }),
  )

  it.live("a configured SearXNG is the only engine asked", () =>
    Effect.gen(function* () {
      const asked: string[] = []
      const outcome = yield* Effect.gen(function* () {
        const search = yield* WebSearch.Service
        const result = yield* search.search("bun")
        const described = yield* search.describe()
        return { result, described }
      }).pipe(
        Effect.provide(
          service(
            async (url) => {
              asked.push(url)
              return json({ results: [{ title: "From my own instance", url: "https://x.test/", content: "c" }] })
            },
            { settings: { web_search: { searxngUrl: "https://searx.example" } } },
          ),
        ),
      )
      expect(outcome.result.ok).toBe(true)
      expect(outcome.result.results[0]?.engine).toBe("searxng")
      expect(asked.every((url) => url.startsWith("https://searx.example"))).toBe(true)
      expect(outcome.described.mode).toBe("searxng")
    }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// THE WEB TRAFFIC GOVERNOR, on search's half of the web surface (2026-07-30).
//
// Search shipped with a raw `fetch`: concurrent, unpaced, uncapped, against DuckDuckGo's HTML scraping
// endpoint — while `webfetch` had ridden `web/governor.ts` the whole time, and while the shipped
// **Traffic limits** panel on the web-search settings page told the user those limits "apply to every web
// read — searches and articles alike". They did not. These tests pin the four properties that decide
// whether the governor is real HERE and not merely imported:
//
//   · a repeat search is refused, and the refusal names the QUERY (ruling 2) — never the engine endpoint;
//   · DIFFERENT searches are never mistaken for a loop, which is the one way a per-URL loop guard could
//     have been actively WRONG for a metasearch fan-out;
//   · the fan-out is not one budget — each engine host has its own, so one capped engine degrades the
//     search instead of killing it;
//   · the loop counter is per SESSION, which only holds because the tool threads `sessionID` through.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 6, 30, 12, 0, 0)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()

/**
 * The service over the REAL governor and a real (in-memory) budget table — clock frozen, sleeps recorded
 * rather than slept, jitter pinned mid-range. Same rig `src/web/governor.test.ts` uses, so a difference
 * here is a difference in the wiring, not in the harness.
 */
const governed = (
  fetchImpl: WebSearchEngine.FetchLike,
  limits: WebGovernor.ResolvedLimits,
  options?: { settings?: Record<string, unknown> },
) => {
  const waits: number[] = []
  const clock = { now: T0 }
  const layer = WebSearch.layerWith(fetchImpl).pipe(
    Layer.provide(offlineMock(false)),
    Layer.provide(settingsMock(options?.settings ?? {})),
    Layer.provide(
      Layer.effect(
        WebGovernor.Service,
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* DatabaseMigration.apply(db)
          return WebGovernor.Service.of(
            WebGovernor.make({
              db,
              limits: () => Effect.succeed(limits),
              now: () => Effect.sync(() => clock.now),
              sleep: (ms) =>
                Effect.sync(() => {
                  waits.push(ms)
                  clock.now += ms // a real sleep advances time; the fake must too or pacing never settles
                }),
              random: () => 0.5, // mid-jitter → deterministic
            }),
          )
        }),
      ).pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true }))),
    ),
  )
  return { layer, waits, clock }
}

const searxngOnly = { settings: { web_search: { searxngUrl: "https://searx.example" } } }
const ddgOnly = { settings: { web_search: { disabledEngines: ["wikipedia"] } } }

describe("web search rides the web traffic governor", () => {
  it.live("repeat reads of one engine host are PACED — the pause the Traffic-limits panel promises", () => {
    const reached: string[] = []
    const rig = governed(
      async (url) => {
        reached.push(url)
        return json({ results: [{ title: "T", url: "https://x.test/", content: "c" }] })
      },
      { intervalMs: 4000, burst: 1, dailyLimit: 50, sameUrlLimit: 9 },
      searxngOnly,
    )
    return Effect.gen(function* () {
      const search = yield* WebSearch.Service
      expect((yield* search.search("one")).ok).toBe(true)
      expect((yield* search.search("two")).ok).toBe(true)
      expect(reached).toHaveLength(2)
      // The burst of 1 is free; the next read of that host waits a whole interval before the socket opens.
      expect(rig.waits).toEqual([4000])
    }).pipe(Effect.provide(rig.layer))
  })

  it.live("the fan-out is NOT one budget: each engine host carries its own, so both engines answer", () => {
    const reached: string[] = []
    const rig = governed(
      async (url) => {
        reached.push(url)
        return url.includes("wikipedia")
          ? json({ query: { search: [{ title: "Bun (software)" }] } })
          : new Response(DDG_HTML, { status: 200 })
      },
      { intervalMs: 1, burst: 5, dailyLimit: 1, sameUrlLimit: 9 },
    )
    return Effect.gen(function* () {
      const search = yield* WebSearch.Service
      const first = yield* search.search("bun runtime")
      expect(first.ok).toBe(true)
      // Both hosts spent their own first read in ONE fan-out — a shared budget would have refused the
      // second engine here, and `degraded` would name it.
      expect(first.degraded).toBeUndefined()
      expect(reached).toHaveLength(2)
      // That was the whole day's allowance for both, so the next search is refused — and says which cap.
      const second = yield* search.search("something else entirely")
      expect(second.ok).toBe(false)
      expect(second.reason).toContain("Daily read limit reached")
      expect(reached).toHaveLength(2) // refused before the socket, not after it
    }).pipe(Effect.provide(rig.layer))
  })

  it.live("a REPEATED query trips the loop guard, and the refusal names the query, not the endpoint", () => {
    const reached: string[] = []
    const rig = governed(
      async (url) => {
        reached.push(url)
        return new Response(DDG_HTML, { status: 200 })
      },
      { intervalMs: 1, burst: 99, dailyLimit: 99, sameUrlLimit: 3 },
      ddgOnly,
    )
    return Effect.gen(function* () {
      const search = yield* WebSearch.Service
      for (let i = 0; i < 3; i++) expect((yield* search.search("bun runtime", { sessionID: "ses_a" })).ok).toBe(true)
      expect(reached).toHaveLength(3)
      const looped = yield* search.search("bun runtime", { sessionID: "ses_a" })
      expect(looped.ok).toBe(false)
      // Ruling 2: the fault is described in the terms the model chose. It asked for a QUERY and has never
      // heard of `html.duckduckgo.com` — naming the endpoint would invite it to webfetch the scraper.
      expect(looped.reason).toContain('Refusing to search for "bun runtime" again')
      expect(looped.reason).not.toContain("duckduckgo.com")
      expect(reached).toHaveLength(3)
    }).pipe(Effect.provide(rig.layer))
  })

  it.live("DIFFERENT searches are never a loop — the per-URL guard is a per-QUERY dedupe here", () => {
    const reached: string[] = []
    const rig = governed(
      async (url) => {
        reached.push(url)
        return new Response(DDG_HTML, { status: 200 })
      },
      { intervalMs: 1, burst: 99, dailyLimit: 99, sameUrlLimit: 3 },
      ddgOnly,
    )
    return Effect.gen(function* () {
      const search = yield* WebSearch.Service
      // Hammering ONE host with distinct queries is what a metasearch does all day; it must never be
      // mistaken for a runaway, which is the failure mode a naive per-host loop key would have shipped.
      for (const query of ["effect schema", "bun test runner", "sqlite wal", "drizzle migrations", "solidjs signals"])
        expect((yield* search.search(query, { sessionID: "ses_a" })).ok).toBe(true)
      expect(reached).toHaveLength(5)
      expect(new Set(reached).size).toBe(5) // five distinct governor keys, one host
    }).pipe(Effect.provide(rig.layer))
  })

  it.live("the loop counter is per SESSION: a new conversation may re-run an exhausted query", () => {
    const rig = governed(
      async () => new Response(DDG_HTML, { status: 200 }),
      { intervalMs: 1, burst: 99, dailyLimit: 99, sameUrlLimit: 2 },
      ddgOnly,
    )
    return Effect.gen(function* () {
      const search = yield* WebSearch.Service
      for (let i = 0; i < 2; i++) expect((yield* search.search("same words", { sessionID: "ses_a" })).ok).toBe(true)
      expect((yield* search.search("same words", { sessionID: "ses_a" })).ok).toBe(false)
      // A different session is a different conversation, not a continuing loop. This only holds because
      // `tool/websearch.ts` passes `context.sessionID` — without it every session shares one counter that
      // never resets for the life of the process.
      expect((yield* search.search("same words", { sessionID: "ses_b" })).ok).toBe(true)
    }).pipe(Effect.provide(rig.layer))
  })

  test("the service DECLARES the governor — the wiring cannot be dropped while the panel keeps promising it", () => {
    expect(WebSearch.node.dependencies.map((dep) => dep.name)).toContain(WebGovernor.Service.key)
  })

  // The type above stops an engine being RUN without a gate. It does not stop a future engine from
  // reaching past `fetchText` and calling `fetchImpl` (or a bare global `fetch`) in its own `search`,
  // which would typecheck fine and go out ungoverned — the exact regression this whole change repairs.
  // One chokepoint is the invariant, so pin the chokepoint.
  test("engine.ts touches the network in exactly ONE place — the gated one", () => {
    const source = readFileSync(path.resolve(import.meta.dir, "..", "src", "websearch", "engine.ts"), "utf8")
    // `fetchImpl(` is the injected transport; the only legal call is the one inside `fetchText`.
    expect(source.match(/fetchImpl\(/g) ?? []).toHaveLength(1)
    // …and nobody reaches for the global instead (`fetchImpl(` can't match this — the char class bites).
    expect(source.match(/(^|[^A-Za-z.])fetch\(/g) ?? []).toEqual([])
  })

  test("an engine CANNOT be run ungoverned — ruling 1's mechanical half is a type, not a convention", () => {
    const engine = WebSearchEngine.duckduckgo(() => Promise.reject(new Error("unused")))
    // @ts-expect-error `gate` is required in `SearchOptions`, so an ungoverned request cannot be written
    // by accident — it has to be a deliberate stub. This suppression is its own negative control: make
    // `gate` optional again and it becomes unused, which `tsgo` reports as an error right here.
    const ungoverned = () => engine.search("q", { limit: 1, timeoutMs: 10 })
    expect(typeof ungoverned).toBe("function")
  })
})

describe("WebSearchTool rendering", () => {
  test("results linearize with their source, and a long snippet is trimmed", () => {
    const text = WebSearchTool.formatResults([
      { title: "Bun", url: "https://bun.sh/", snippet: "x".repeat(500), engine: "duckduckgo+wikipedia" },
    ])
    expect(text).toContain("1. Bun")
    expect(text).toContain("https://bun.sh/ [duckduckgo+wikipedia]")
    expect(text).not.toContain("x".repeat(401))
  })

  test("the input caps result count", () => {
    const decode = Schema.decodeUnknownSync(WebSearchTool.Input)
    expect(decode({ query: "x" }).query).toBe("x")
    expect(() => decode({ query: "x", numResults: WebSearchTool.MAX_NUM_RESULTS + 1 })).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PERMISSION GATE. This tool asserted NOTHING until now — an egress channel with no gate at all,
// in a product whose design-principle 4 makes the data plane's non-egress load-bearing and fully
// airgappable. Its sibling `webfetch` has been gated the whole time, and `config/permission.ts` has
// advertised a `websearch` key the whole time, so a privacy-minded user could set a knob that
// governed nothing — ruling 2's *a fault is never described falsely*, on the first surface they'd try.
//
// ⚠️ The airgap gate above is a DIFFERENT gate and neither replaces the other: `Offline` answers "may
// this instance reach the WAN at all" (machine-level, live, not consentable — and web search needs its
// own check because its engines call raw `fetch` rather than riding the shared HttpClient node), while
// this answers "may THIS SESSION, and does a human agree" (per-session, consentable, saveable). The
// assert sits above the engine choice, so it can only refuse; it cannot weaken the airgap.
//
// What these tests pin is not "does it assert" — that a `grep` could tell you — but the two properties
// that decide whether the gate is real: that a denied search never reaches an engine (an assert placed
// AFTER `search.search` would still be an assert), and that the denial reaches the MODEL as the denial
// (an absorbed error still produces a tool failure, and an unattended run that reads "search failed"
// retries for the whole run instead of routing around it).
// ─────────────────────────────────────────────────────────────────────────────

const sessionID = SessionV2.ID.make("ses_websearch_test")
const assertions: PermissionV2.AssertInput[] = []
const queries: Array<{ readonly query: string; readonly limit?: number; readonly sessionID?: string }> = []
/** Swapped per test: what the (mocked) evaluator answers. `undefined` = allow. */
let verdict: PermissionV2.Error | SessionV2.NotFoundError | undefined

const permissionMock = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(Effect.andThen(verdict ? Effect.fail(verdict) : Effect.void)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const searchMock = Layer.succeed(
  WebSearch.Service,
  WebSearch.Service.of({
    search: (query, options) =>
      Effect.sync(() => {
        queries.push({
          query,
          ...(options?.limit === undefined ? {} : { limit: options.limit }),
          ...(options?.sessionID === undefined ? {} : { sessionID: options.sessionID }),
        })
        return {
          ok: true,
          results: [{ title: "Result", url: "https://example.com/a", snippet: "snip", engine: "duckduckgo" }],
        }
      }),
    describe: () => Effect.succeed({ mode: "builtin" as const, detail: "Built-in search." }),
  }),
)

const gated = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebSearchTool.node]), [
    [PermissionV2.node, permissionMock],
    [WebSearch.node, searchMock],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

const reset = () => {
  assertions.length = 0
  queries.length = 0
  verdict = undefined
}

const call = (input: typeof WebSearchTool.Input.Type, id = "call-websearch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "websearch", input },
})

describe("WebSearchTool is permission-gated", () => {
  gated.effect("asserts `websearch` on the query, in webfetch's exact shape", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      expect(yield* executeTool(registry, call({ query: "effect schema", numResults: 3 }))).toMatchObject({
        type: "text",
      })
      // `action: name` — the REGISTERED name, so the horizon filter (`ToolRegistry.materialize`) and
      // the execution gate resolve the same action and no `withPermission` remap is needed. That
      // agreement is what the `apply_patch` ledger entry in `test/tool-permission-identity.test.ts`
      // exists to protect, and what `glob`/`grep` (registered `glob`/`grep`, asserting `explore`) do
      // NOT have.
      expect(assertions).toMatchObject([
        {
          sessionID,
          action: "websearch",
          resources: ["effect schema"],
          save: ["*"],
          metadata: { query: "effect schema", numResults: 3 },
          source: { type: "tool" },
        },
      ])
      // The SESSION travels with the query, because the traffic governor's loop guard is per session —
      // drop it and every session's searches pool into one counter that never resets.
      expect(queries).toEqual([{ query: "effect schema", limit: 3, sessionID }])
    }),
  )

  gated.effect("a DENIED search never reaches an engine — the gate is before the egress, not beside it", () =>
    Effect.gen(function* () {
      reset()
      verdict = new PermissionV2.DeniedError({ rules: [{ action: "websearch", resource: "*", effect: "deny" }] })
      const registry = yield* ToolRegistry.Service
      expect((yield* executeTool(registry, call({ query: "secret query" }))).type).toBe("error")
      // The property that matters: not one query left the process. An assert placed after
      // `search.search` would satisfy "the tool asserts websearch" and fail exactly here.
      expect(queries).toEqual([])
      expect(assertions).toHaveLength(1)
    }),
  )

  gated.effect("the denial reaches the MODEL as the denial, not as a search failure", () =>
    Effect.gen(function* () {
      reset()
      // The verdict this tool will actually meet on a scheduled run: `websearch` is not in
      // `AMBIENT_SAFE_BASELINE` (an egress action fails the membership tests), so nobody granted it,
      // so the evaluator falls through to `ask` — and an unattended ask now deny-fasts. The routing
      // advice has to survive the tool's error mapping or the model retries for the whole run.
      verdict = new PermissionV2.DeniedError({
        rules: [{ action: "websearch", resource: "*", effect: "deny" }],
        reason: "unattended-unanswerable",
      })
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ query: "current events" }))
      expect(result).toEqual({ type: "error", value: PermissionV2.denialMessage(verdict)! })
      expect(result.value).toContain("websearch")
      expect(result.value).toContain("UNATTENDED")
      // NEGATIVE CONTROL for the absorbing shape: this is what the model would read if the mapError
      // collapsed the error the way `webfetch` still does, and it says nothing actionable.
      expect(result.value).not.toBe("Unable to search the web for current events")
    }),
  )

  gated.effect("a NON-permission failure still gets the plain fallback", () =>
    Effect.gen(function* () {
      reset()
      // `denialMessage` answers `undefined` for anything that is not a permission error, so the
      // fallback arm must stay reachable — otherwise the mapError would hand the model `undefined`.
      // `Session.NotFoundError` is the other error the assert can raise.
      verdict = new SessionV2.NotFoundError({ sessionID })
      const registry = yield* ToolRegistry.Service
      expect(yield* executeTool(registry, call({ query: "orphaned" }))).toEqual({
        type: "error",
        value: "Unable to search the web for orphaned",
      })
      expect(queries).toEqual([])
    }),
  )
})
