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
 * ⚠️ **Measured 2026-08-04, and it bounds what this file claims.** 176 paths: 93 under `/api/*`,
 * **83 legacy** (94 legacy operations across the five methods). Ruling 11 was written against 97
 * legacy paths, so the set has already shrunk by fourteen — this file is what stops it going back. It
 * closes no live bug; it is a guard against the NEXT route, which is the only form this invariant
 * can take.
 *
 * ⚠️ **The 2026-07-31 shrink is `GET /permission` + `POST /permission/{requestID}/reply`** — the V1
 * permission routes, deleted with the V1 engine they served (v0.2.0-prep Wave 4 §5). This edit is
 * only true once `bun run --cwd packages/sdk/js regen` has rewritten `openapi.json`: the ledger
 * measures the committed spec, so ledger and spec must move in the SAME commit or this file is red
 * either way round.
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
 * **The legacy paths, pinned as of 2026-07-31.** Grouped by first segment with its count so the
 * shape is readable at a glance: 26 families, 86 paths. This list may only ever get SHORTER.
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
  // /config — 2
  "/config",
  "/config/providers",
  // /event — 1
  "/event",
  // /experimental — 12
  "/experimental/control-plane/move-session",
  "/experimental/resource",
  "/experimental/tool",
  "/experimental/tool/ids",
  "/experimental/workspace",
  "/experimental/workspace/adapter",
  "/experimental/workspace/status",
  "/experimental/workspace/sync-list",
  "/experimental/workspace/warp",
  "/experimental/workspace/{id}",
  "/experimental/worktree",
  "/experimental/worktree/reset",
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
  // /formatter — 1
  "/formatter",
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
  "/question",
  "/question/{requestID}/reject",
  "/question/{requestID}/reply",
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
  // /skill — 1
  "/skill",
  // /sync — 4
  "/sync/history",
  "/sync/replay",
  "/sync/start",
  "/sync/steal",
  // /vcs — 5
  "/vcs",
  "/vcs/apply",
  "/vcs/diff",
  "/vcs/diff/raw",
  "/vcs/status",
]

/**
 * Legacy OPERATIONS (method + path), measured 2026-07-31: GET 47, POST 42, DELETE 6, PUT 3,
 * PATCH 2.
 *
 * The path ledger alone would let `POST /file` be added beside the existing `GET /file` — a new
 * legacy route on an already-pinned path, which is the same widening under a different name. This
 * number closes that seam without a second 102-line list.
 */
const LEGACY_OPERATION_COUNT = 94

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
    expect(LEGACY_PATHS.length, "the ledger's own length moved — recount and update this pin").toBe(83)
    expect(
      SPEC_LEGACY_PATHS.length,
      "the spec's legacy path count moved — reconcile LEGACY_PATHS and update this pin",
    ).toBe(83)
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
    expect(unpinnedLegacyPaths(["/vcs/status"], PINNED)).toEqual([])
    expect(unpinnedLegacyPaths(["/vcs/status"], new Set())).toEqual(["/vcs/status"])
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
