import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * **Every path the API declares is either under `/api/*`, or it is on the ledger below.** todo.md
 * ruling 11: "`packages/protocol`'s HttpApi is the one contract, one generated artifact, one API
 * version. Pin the legacy paths so that set can only **shrink** — a new route outside `/api/*` fails
 * a test, not a review." The ruling was recorded 2026-07-27; until this file existed, nothing
 * enforced it, which is precisely the defect class ruling 1 names — *an invariant whose violation
 * compiles green ships with a mechanical check, or the invariant does not exist.*
 *
 * The two route surfaces are declared in different files, and that is the whole reason a review
 * cannot be the guard:
 *
 *   `/api/*`  — `packages/protocol/src/groups/*.ts`, the ONE contract, free to grow.
 *   legacy    — `packages/novaclaw/src/server/routes/instance/httpapi/api.ts` + its `groups/`,
 *               the pre-v2 surface, which may only shrink.
 *
 * Adding an endpoint to the legacy side is one `HttpApiEndpoint.get(...)` line in a file that is
 * already full of them. It typechecks, it works, it reviews as "consistent with the neighbours" —
 * and it silently widens the surface the v2 collapse has to carry. This file makes that line red.
 *
 * ⚠️ **Why pinning a GENERATED artifact is sound here, and only here.** `packages/sdk/openapi.json`
 * is emitted by `bun dev generate`, so on its own a pin against it would be a pin against an output
 * — a route added *without* regen would leave this file green and lying. It does not, because this
 * file's neighbour `generated-drift.test.ts` re-derives the spec from the live API on every
 * fast-tier run and fails byte-exact if the committed file drifted. Both doors are therefore shut:
 * a route added WITHOUT regen turns the drift test red, and a route added WITH regen turns THIS
 * test red. Neither door is the honest way through; the honest way is `/api/*`.
 *
 * ⚠️ **Why not `packages/protocol`.** Protocol's HttpApi contains only the `/api/*` half. A
 * protocol-side test structurally cannot see a legacy path, so it could only ever assert an empty
 * set — the guard-shaped no-op. The spec is the one artifact where both halves are visible at once.
 *
 * The ledger is a RATCHET and fails in both directions. A legacy path that is not listed fails
 * outright; a listed path the spec no longer declares fails with "delete the ledger line", so
 * un-pinning is mandatory rather than optional and the set can only get smaller.
 *
 * ⚠️ **Measured 2026-08-07, and it bounds what this file claims.** 176 paths: 94 under `/api/*`,
 * **82 legacy** (93 legacy operations across the five methods). Ruling 11 was written against 97
 * legacy paths, so the set has already shrunk by fifteen — this file is what stops it going back. It
 * closes no live bug; it is a guard against the NEXT route, which is the only form this invariant
 * can take. (The `/api/*` half moved 93 → 94 over the same window; it is free to grow, which is why
 * only the legacy half is pinned.)
 *
 * ⚠️ **The 2026-07-31 shrink is `GET /permission` + `POST /permission/{requestID}/reply`** — the V1
 * permission routes, deleted with the V1 engine they served (v0.2.0-prep Wave 4 §5). This edit is
 * only true once `bun run --cwd packages/sdk/js regen` has rewritten `openapi.json`: the ledger
 * measures the committed spec, so ledger and spec must move in the SAME commit or this file is red
 * either way round.
 *
 * ⚠️ **The 2026-08-07 shrink is `GET /skill`, and it was a live staleness bug rather than tidy-up.**
 * The legacy route read `Skill.Service`, which is `InstanceState.make` and registers for NO reload
 * domain — so a config write left it serving a stale list until the instance was disposed. `/api/skill`
 * is served by core's `SkillV2` (`packages/server/src/handlers/skill.ts`), registered for the `skills`
 * domain, and is a superset (adds `slash?`) though wrapped as `{location, data: […]}` rather than a
 * bare array. Ruling 11 plus design-principle 1 say delete the legacy path, not build it a second
 * refresh path. `Skill.Service` itself STAYS — `agent/agent.ts` needs `skill.dirs()` for the
 * `external_directory` whitelist and `novaclaw debug skill` calls `skill.all()`.
 */

/** `packages/sdk/js/test` → `packages/sdk/openapi.json`, the committed generated spec. */
const SPEC_PATH = path.resolve(import.meta.dir, "../../openapi.json")

/**
 * The ONE contract prefix (ruling 11). Everything else in the document is legacy by definition —
 * there is no third category, and inventing one is the thing this file exists to prevent.
 */
const API_PREFIX = "/api/"

/** The methods OpenAPI 3.1 path items can carry that this project actually emits. */
const METHODS = ["get", "post", "put", "delete", "patch"] as const

type Document = { paths: Record<string, Record<string, unknown>> }

/**
 * **The legacy paths, pinned as of 2026-08-07.** Grouped by first segment with its count so the
 * shape is readable at a glance: 23 families, 69 paths. This list may only ever get SHORTER.
 *
 * There is no production module that owns this set — it is a property of the union of two route
 * trees — so the ledger lives here, next to the assertions that read it.
 */
export const LEGACY_PATHS: readonly string[] = [
  // /adhoc — 3
  "/adhoc/session/{sessionID}",
  "/adhoc/session/{sessionID}/{name}",
  "/adhoc/session/{sessionID}/{name}/promote",
  // /agent — 1
  "/agent",
  // /app — 1
  "/app",
  // /auth — 1
  "/auth/{providerID}",
  // /command — 1
  "/command",
  // /config — 1
  "/config",
  // /experimental — 2
  "/experimental/control-plane/move-session",
  // The new-session composer calls this operation directly. Its 2026-09-01 removal was a false
  // shrink exposed by the app typecheck, not a legitimate widening of the legacy surface.
  "/experimental/worktree",
  // /file — 7
  "/file",
  "/file/content",
  "/file/mkdir",
  "/file/rename",
  "/file/status",
  "/file/trash",
  "/file/trash/restore",
  // /find — 2
  "/find",
  "/find/file",
  // /global — 6
  "/global/config",
  "/global/discovery",
  "/global/dispose",
  "/global/event",
  "/global/health",
  "/global/resources",
  // /instance — 1
  "/instance/dispose",
  // /log — 1
  "/log",
  // /mcp — 6
  "/mcp",
  "/mcp/{name}/auth",
  "/mcp/{name}/auth/authenticate",
  "/mcp/{name}/auth/callback",
  "/mcp/{name}/connect",
  "/mcp/{name}/disconnect",
  // /memory — 11
  "/memory/clearScope",
  "/memory/graph",
  "/memory/ingest",
  "/memory/invalidate",
  "/memory/list",
  "/memory/neighbors",
  "/memory/path",
  "/memory/purge",
  "/memory/remember",
  "/memory/search",
  "/memory/stats",
  // /path — 1
  "/path",
  // /provider — 3
  "/provider",
  "/provider/presets",
  "/provider/{providerID}/probe",
  // /question — 3
  // /registry — 5
  "/registry/row/delete",
  "/registry/row/insert",
  "/registry/row/update",
  "/registry/rows",
  "/registry/tables",
  // /scheduler — 1
  "/scheduler/snapshot",
  // /shell — 3
  "/shell/offline",
  "/shell/provision",
  "/shell/status",
  // /sync — 3
  "/sync/history",
  "/sync/replay",
  "/sync/steal",
  // /vcs — GONE 2026-09-03. The family moved to `/api/vcs*` (protocol `groups/vcs.ts`, served by
  // `novaclaw/…/handlers/vcs.ts`), which is the last row of the event-stream shrink's ledger.
]

/**
 * Legacy OPERATIONS (method + path), measured 2026-09-03: GET 28, POST 33, DELETE 3, PUT 2,
 * PATCH 2 — 68 in total.
 *
 * ⚠️ This header has been wrong twice, the same way both times: the pin moved and the prose did
 * not. It read "measured 2026-07-31: GET 47, POST 42, DELETE 6, PUT 3, PATCH 2" (sum 100) against a
 * pin of 94, was corrected on 2026-09-01 to five numbers summing to 77 against a pin of 73, and is
 * re-derived here from the committed spec at a pin of 68 — which these five DO sum to. If you change
 * one, re-derive all five from `packages/sdk/openapi.json` rather than adjusting by hand; a
 * breakdown that does not sum to the constant is worse than no breakdown, because it reads as a
 * measurement.
 *
 * The path ledger alone would let `POST /file` be added beside the existing `GET /file` — a new
 * legacy route on an already-pinned path, which is the same widening under a different name. This
 * number closes that seam without a second 102-line list.
 */
const LEGACY_OPERATION_COUNT = 68

const PINNED = new Set(LEGACY_PATHS)

/** No third category: a path is contract if and only if it sits under `/api/`. */
export const isLegacyPath = (route: string): boolean => !route.startsWith(API_PREFIX)

/** GROWTH offenders: legacy paths the document declares that the ledger does not pin. */
export function unpinnedLegacyPaths(routes: readonly string[], pinned: ReadonlySet<string>): string[] {
  return routes.filter((route) => isLegacyPath(route) && !pinned.has(route)).sort()
}

/** SHRINK debt: ledger entries the document no longer justifies, one line each with its reason. */
export function stalePins(routes: readonly string[], pinned: readonly string[]): string[] {
  const declared = new Set(routes)
  const seen = new Set<string>()
  const stale: string[] = []
  for (const route of pinned) {
    if (seen.has(route)) {
      stale.push(`${route} (pinned twice — delete the duplicate ledger line)`)
      continue
    }
    seen.add(route)
    if (!declared.has(route))
      stale.push(`${route} (the spec no longer declares it — DELETE the ledger line; the pin only shrinks)`)
    else if (!isLegacyPath(route))
      stale.push(`${route} (now lives under /api/* — DELETE the ledger line; it is contract, not legacy)`)
  }
  return stale
}

/** Every legacy `METHOD /path` the document declares, sorted. */
export function legacyOperations(document: Document): string[] {
  const operations: string[] = []
  for (const [route, item] of Object.entries(document.paths)) {
    if (!isLegacyPath(route)) continue
    for (const method of METHODS) if (item[method]) operations.push(`${method.toUpperCase()} ${route}`)
  }
  return operations.sort()
}

const RAW = fs.existsSync(SPEC_PATH) ? fs.readFileSync(SPEC_PATH, "utf8") : ""
const DOCUMENT = RAW.length > 0 ? (JSON.parse(RAW) as Document) : ({ paths: {} } as Document)
const ALL_PATHS = Object.keys(DOCUMENT.paths)
const API_PATHS = ALL_PATHS.filter((route) => !isLegacyPath(route))
const SPEC_LEGACY_PATHS = ALL_PATHS.filter(isLegacyPath)

/** What a reader should DO about a failure, appended to every actionable message below. */
const REMEDY = [
  "Declare the route in packages/protocol/src/groups/*.ts under /api/* — that is the ONE contract",
  "(todo.md ruling 11), and the /api/* half is free to grow. Only if it genuinely cannot live there:",
  "add the path to LEGACY_PATHS in this file, and expect to justify growing a set that is supposed",
  "to shrink. Then re-run:  bun run --cwd packages/sdk/js regen",
].join("\n  ")

describe("the sweep", () => {
  test("actually has a spec to look at", () => {
    // A moved or renamed spec would empty every set below and turn each assertion into a tautology
    // that passes forever — the exact failure mode this block exists to make impossible.
    expect(fs.existsSync(SPEC_PATH), `${SPEC_PATH} is gone — repoint the sweep`).toBe(true)
    expect(RAW.length, "the committed spec is empty or unreadable").toBeGreaterThan(100_000)
    expect(typeof DOCUMENT.paths, "the parsed spec has no `paths` object").toBe("object")
    // Sane range, not an exact pin: `/api/*` is allowed to grow, so the total moves legitimately.
    expect(ALL_PATHS.length).toBeGreaterThan(120)
    expect(ALL_PATHS.length).toBeLessThan(400)
  })

  test("both halves are non-trivial — neither the contract nor the legacy set is silently empty", () => {
    // If the prefix test ever broke so that everything read as `/api/*`, the growth check below
    // would compare two empty sets and pass. Both halves are asserted large so it cannot.
    expect(API_PATHS.length, "no /api/* paths found — has API_PREFIX drifted?").toBeGreaterThan(50)
    expect(SPEC_LEGACY_PATHS.length, "no legacy paths found — has API_PREFIX drifted?").toBeGreaterThan(50)
    expect(API_PATHS.length + SPEC_LEGACY_PATHS.length).toBe(ALL_PATHS.length)
  })

  test("the ledger itself is a real list, with no duplicate lines", () => {
    expect(LEGACY_PATHS.length).toBeGreaterThan(50)
    expect(new Set(LEGACY_PATHS).size, "LEGACY_PATHS contains a duplicate path").toBe(LEGACY_PATHS.length)
  })

  test("the operation counter sees every method the spec actually uses", () => {
    // `METHODS` is a hand-written list. A spec that started emitting `head`/`options`/`trace` would
    // make the operation pin blind to a whole method, so the omission fails here instead.
    const emitted = new Set(Object.values(DOCUMENT.paths).flatMap((item) => Object.keys(item)))
    const unknown = [...emitted].filter((method) => !(METHODS as readonly string[]).includes(method)).sort()
    expect(unknown, "the spec emits a method METHODS does not count — add it").toEqual([])
    expect(legacyOperations(DOCUMENT).length).toBeGreaterThan(50)
  })
})

describe("every legacy path is on the ledger, and the ledger can only shrink", () => {
  test("a new route outside /api/* fails HERE, not in a review", () => {
    const unpinned = unpinnedLegacyPaths(ALL_PATHS, PINNED)
    expect(
      unpinned,
      [
        "A path outside /api/* is declared that the legacy ledger does not pin:",
        `  ${unpinned.join("\n  ") || "(none)"}`,
        "",
        `  ${REMEDY}`,
      ].join("\n"),
    ).toEqual([])
  })

  test("the ledger can only SHRINK — a vanished path must be DELETED from it", () => {
    const stale = stalePins(ALL_PATHS, LEGACY_PATHS)
    expect(
      stale,
      [
        "The legacy ledger pins paths the spec no longer justifies. Un-pinning is MANDATORY:",
        `  ${stale.join("\n  ")}`,
        "",
        "  Delete those lines from LEGACY_PATHS in this file, fix the per-family count comment,",
        "  and lower the measured totals in the pin below. A ledger that keeps dead entries stops",
        "  being a measurement of the real surface.",
      ].join("\n"),
    ).toEqual([])
  })

  test("the ledger is exactly today's measured legacy surface", () => {
    // Pinned as a MEASUREMENT, not a preference: the honest answer to "how big is the legacy surface
    // right now". Removing a legacy route is supposed to fail here — that failure IS the ratchet
    // clicking, and lowering these numbers is how the removal gets recorded.
    expect(LEGACY_PATHS.length, "the ledger's own length moved — recount and update this pin").toBe(60)
    expect(
      SPEC_LEGACY_PATHS.length,
      "the spec's legacy path count moved — reconcile LEGACY_PATHS and update this pin",
    ).toBe(60)
    expect(
      legacyOperations(DOCUMENT).length,
      [
        "The legacy OPERATION count moved without the path set moving — i.e. a method was added to",
        "(or removed from) a path that is already pinned. A new method on a pinned path is still a",
        "new legacy route.",
        "",
        `  ${REMEDY}`,
      ].join("\n"),
    ).toBe(LEGACY_OPERATION_COUNT)
  })
})

describe("the guard actually bites (negative control)", () => {
  test("a fabricated legacy path is reported, and an /api/* path never is", () => {
    // Every real assertion above is `toEqual([])`, and an empty array alone cannot show that a
    // non-empty one is reachable. This drives the same pure predicates directly.
    const fabricated = "/totally-new-legacy-route"
    expect(unpinnedLegacyPaths([...LEGACY_PATHS, fabricated], PINNED)).toEqual([fabricated])
    // …and the contract half stays free to grow, however new the route is.
    expect(unpinnedLegacyPaths(["/api/totally-new-contract-route"], PINNED)).toEqual([])
    // A pinned path is not an offender — the ledger is what excuses it, nothing else.
    expect(unpinnedLegacyPaths(["/shell/status"], PINNED)).toEqual([])
    expect(unpinnedLegacyPaths(["/shell/status"], new Set())).toEqual(["/shell/status"])
  })

  test("the shrink half reports a pin the spec no longer declares", () => {
    expect(stalePins(["/agent"], ["/agent", "/deleted-yesterday"])).toEqual([
      "/deleted-yesterday (the spec no longer declares it — DELETE the ledger line; the pin only shrinks)",
    ])
    // A path that graduated INTO the contract must also leave the ledger.
    expect(stalePins(["/api/agent"], ["/api/agent"])).toEqual([
      "/api/agent (now lives under /api/* — DELETE the ledger line; it is contract, not legacy)",
    ])
    // …and a duplicated line is caught rather than silently inflating the count.
    expect(stalePins(["/agent"], ["/agent", "/agent"])).toEqual([
      "/agent (pinned twice — delete the duplicate ledger line)",
    ])
    expect(stalePins(["/agent"], ["/agent"])).toEqual([])
  })

  test("the operation counter counts methods, not paths", () => {
    // The seam the path ledger cannot see: one path, two operations.
    const fabricated: Document = {
      paths: {
        "/file": { get: {}, post: {} },
        "/api/session": { get: {}, delete: {} },
      },
    }
    expect(legacyOperations(fabricated)).toEqual(["GET /file", "POST /file"])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE SECOND HOME (RF-13-7, 2026-09-03). The pin above says a path is contract iff it sits under
// `/api/*` — and that is exactly the escape hatch: a route DECLARED in the instance family
// (`packages/novaclaw/src/server/routes/instance/httpapi/groups/*.ts`) under an `/api/…` path
// read as contract to the ledger above while living in the home ruling 11 says is welded to server
// internals. Forty-three had been added that way, and the group files cite the ledger as the
// precedent. So the escape hatch is now NAMED: every `/api/*` path in the spec must be declared in
// `packages/protocol`, or be on this list — which, like the one above, may only shrink.
//
// "Declared in protocol" is measured against the SOURCE (`packages/protocol/src/groups/*.ts`), by
// path literal, `:param` normalised to `{param}`; a wildcard path (`/api/fs/read/*`) is declared by
// its prefix literal. A spec path this scan cannot find in protocol source and cannot find here
// fails; a listed path the spec drops, or that protocol now declares, fails with "delete the line".
// ─────────────────────────────────────────────────────────────────────────────────────────
export const INSTANCE_DECLARED_API_PATHS: readonly string[] = [
  "/api/capability",
  "/api/capability/{name}/retry",
  "/api/community/ask",
  "/api/community/channel",
  "/api/community/channel/archived",
  "/api/community/channel/{name}",
  "/api/community/channel/{name}/history",
  "/api/community/channel/{name}/listed",
  "/api/community/channel/{name}/mute",
  "/api/community/channel/{name}/post",
  "/api/community/channel/{name}/sync",
  "/api/community/contact",
  "/api/community/contact/{networkID}",
  "/api/community/contact/{networkID}/block",
  "/api/community/direct",
  "/api/community/direct/{networkID}",
  "/api/community/direct/{networkID}/history",
  "/api/community/discover",
  "/api/community/dm",
  "/api/community/doorman",
  "/api/community/filter",
  "/api/community/identity",
  "/api/community/inbound",
  "/api/community/listed",
  "/api/community/nearby",
  "/api/community/offer",
  "/api/community/offer/mine",
  "/api/community/offers",
  "/api/community/participation",
  "/api/community/peers",
  "/api/community/rotate",
  "/api/community/search",
  "/api/community/search-channels",
  "/api/community/succession",
  "/api/community/sync/ids",
  "/api/community/sync/messages",
  "/api/community/sync/summary",
  "/api/community/transport",
  "/api/diagnosis",
  "/api/identity/backup",
  "/api/identity/restore",
  "/api/policy",
  "/api/plugin",
  "/api/project",
  "/api/usage",
]

const PROTOCOL_GROUPS = path.resolve(import.meta.dir, "../../../protocol/src/groups")

/** Every `/api/…` path literal `packages/protocol` declares, in the spec's `{param}` spelling. */
export function protocolDeclaredApiPaths(dir: string = PROTOCOL_GROUPS): Set<string> {
  const declared = new Set<string>()
  if (!fs.existsSync(dir)) return declared
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue
    const source = fs
      .readFileSync(path.join(dir, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    for (const match of source.matchAll(/"(\/api\/[^"]*)"/g))
      declared.add(match[1]!.replace(/:([A-Za-z0-9_]+)/g, "{$1}"))
  }
  return declared
}

const isProtocolDeclared = (route: string, declared: ReadonlySet<string>): boolean =>
  declared.has(route) || (route.endsWith("/*") && declared.has(route.slice(0, -1)))

describe("the second home — /api/* paths declared outside packages/protocol", () => {
  const declared = protocolDeclaredApiPaths()
  const listed = new Set(INSTANCE_DECLARED_API_PATHS)

  test("the protocol scan sees the contract — it is not an empty set that makes every path an escape", () => {
    expect(
      declared.size,
      "no /api literals found under packages/protocol/src/groups — repoint the scan",
    ).toBeGreaterThan(50)
    expect(isProtocolDeclared("/api/fs/read/*", declared)).toBe(true)
  })

  test("🔴 every /api/* path in the spec is declared in packages/protocol, or is on the list", () => {
    const unlisted = API_PATHS.filter((route) => !isProtocolDeclared(route, declared) && !listed.has(route)).sort()
    expect(
      unlisted,
      [
        "These /api/* paths are declared OUTSIDE packages/protocol and are not on INSTANCE_DECLARED_API_PATHS.",
        "The instance family is welded to server internals (todo.md ruling 11); a route added there under",
        "/api/* read as contract to the ledger above while growing the second home. Declare it in",
        "packages/protocol/src/groups/*.ts, or — only if it genuinely cannot live there — add it to the",
        "list and expect to justify growing a set that is supposed to shrink.",
      ].join("\n  "),
    ).toEqual([])
  })

  test("the list only SHRINKS — a path the spec dropped or protocol now declares must leave it", () => {
    const specPaths = new Set(API_PATHS)
    const stale = INSTANCE_DECLARED_API_PATHS.filter((route) => !specPaths.has(route)).map(
      (route) => `${route} (the spec no longer declares it — DELETE the line)`,
    )
    const promoted = INSTANCE_DECLARED_API_PATHS.filter((route) => isProtocolDeclared(route, declared)).map(
      (route) => `${route} (packages/protocol declares it now — DELETE the line; it is contract)`,
    )
    expect([...stale, ...promoted]).toEqual([])
    expect(new Set(INSTANCE_DECLARED_API_PATHS).size).toBe(INSTANCE_DECLARED_API_PATHS.length)
  })

  test("the scan bites (negative control)", () => {
    expect(isProtocolDeclared("/api/no/such/route", declared)).toBe(false)
    expect(protocolDeclaredApiPaths(path.join(PROTOCOL_GROUPS, "no-such-dir")).size).toBe(0)
  })
})
