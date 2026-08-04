import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AppRegistry } from "@novaclaw/core/app-registry"

/**
 * **`RESERVED_IDS` is DECLARED TWICE, and the two copies must never disagree.**
 *
 * `packages/core/src/app-registry.ts` guards the server path — the `register-app` tool and the HTTP
 * endpoint, both fed ids by models and clients. `packages/app/src/apps/registry.tsx` guards
 * `registerApp`, which a plugin reaches IN-PROCESS in the renderer and which never touches the
 * server. Neither is redundant: an id reserved on only one side is squattable through the other.
 *
 * They diverged. `debug` was in neither list until 2026-07-29 although it is a built-in tile
 * (`app-label.ts` → `BUILTIN_APP_LABELS`), so a plugin or an agent could replace the Debug app —
 * the one surface a user reaches when the product is already broken, which ruling 2 singles out as
 * the place a disabled-with-reason answer is NOT acceptable.
 *
 * ⚠️ **Why two lists and not one constant.** The renderer cannot import
 * `@novaclaw/core/app-registry`: that module reaches `node:fs/promises` and `Global`, so pulling it
 * into a browser bundle to share fourteen strings would drag the instance's data-directory
 * resolution into the UI. Cross-package, renderer-facing, and node-only is exactly the case where
 * "make it structurally impossible to diverge" costs more than it buys — so the duplication stays
 * and this file is the mechanism that makes it safe (todo.md ruling 1: an invariant whose violation
 * compiles green ships with a mechanical check, or it does not exist).
 *
 * The check reads SOURCE rather than importing either module, because importing the renderer half
 * would need a DOM/solid environment in a core unit, and importing the core half would only ever
 * confirm the copy the core already believes.
 */

/** `packages/core/test` → `packages/core` → `packages` → the app repo root. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")

const CORE = "packages/core/src/app-registry.ts"
const APP = "packages/app/src/apps/registry.tsx"
const LABELS = "packages/app/src/apps/app-label.ts"

const read = (name: string) => fs.readFileSync(path.join(ROOT, name), "utf8")

/**
 * The string literals of the `RESERVED_IDS = new Set([...])` declaration, in source order.
 * `undefined` when the declaration is not found — a failure, never an empty pass.
 */
function reservedIn(source: string): string[] | undefined {
  const open = source.indexOf("RESERVED_IDS = new Set([")
  if (open < 0) return undefined
  const close = source.indexOf("])", open)
  if (close < 0) return undefined
  return [...source.slice(open, close).matchAll(/"([^"\n]+)"/g)].map((match) => match[1]!)
}

/** The keys of `BUILTIN_APP_LABELS` — the id set the launcher actually offers as tiles. */
function builtinTileIds(source: string): string[] | undefined {
  const open = source.indexOf("export const BUILTIN_APP_LABELS = {")
  if (open < 0) return undefined
  const close = source.indexOf("\n} as const", open)
  if (close < 0) return undefined
  return [...source.slice(open, close).matchAll(/^ {2}(?:"([^"\n]+)"|([A-Za-z_$][\w$]*))\s*:\s*\{/gm)].map(
    (match) => match[1] ?? match[2]!,
  )
}

const core = reservedIn(read(CORE))
const app = reservedIn(read(APP))
const tiles = builtinTileIds(read(LABELS))

describe("the reader found all three declarations", () => {
  test("each file yields a non-trivial list", () => {
    // A moved file or a reformatted declaration would silently empty every set below and turn the
    // comparisons into tautologies that agree forever.
    expect(core, `${CORE} — RESERVED_IDS not found`).toBeDefined()
    expect(app, `${APP} — RESERVED_IDS not found`).toBeDefined()
    expect(tiles, `${LABELS} — BUILTIN_APP_LABELS not found`).toBeDefined()
    expect(core!.length).toBeGreaterThanOrEqual(14)
    expect(app!.length).toBeGreaterThanOrEqual(14)
    expect(tiles!.length).toBeGreaterThanOrEqual(14)
    for (const list of [core!, app!, tiles!]) expect(list).toContain("chats")
  })

  test("no duplicates in either list", () => {
    // A `Set` literal silently swallows a repeat, so the source is the only place it is visible.
    expect(core!.filter((id, index) => core!.indexOf(id) !== index)).toEqual([])
    expect(app!.filter((id, index) => app!.indexOf(id) !== index)).toEqual([])
  })
})

describe("the two RESERVED_IDS lists are the same list", () => {
  test("core and app reserve exactly the same ids", () => {
    const onlyCore = core!.filter((id) => !app!.includes(id))
    const onlyApp = app!.filter((id) => !core!.includes(id))
    expect(
      { onlyCore, onlyApp },
      [
        "The two RESERVED_IDS declarations have diverged.",
        `  ${CORE}`,
        `  ${APP}`,
        "They are declared mirrors: the first guards the tool + HTTP path, the second guards the",
        "in-process registerApp a plugin calls in the renderer. An id reserved on only one side can",
        "still be squatted through the other. Add it to BOTH, or remove it from both.",
      ].join("\n"),
    ).toEqual({ onlyCore: [], onlyApp: [] })
  })

  test("the runtime guard agrees with the source the reader parsed", () => {
    // Reading source proves the two FILES agree; this proves the parsed list is the one core's
    // exported `normalize` actually enforces, so a refactor that moves the check elsewhere cannot
    // leave this file congratulating a dead constant.
    for (const id of core!)
      expect(() => AppRegistry.normalize({ title: id, id, open: { type: "route", value: "/x" } })).toThrow(/reserved/)
    expect(AppRegistry.normalize({ title: "Stock prices", open: { type: "route", value: "/x" } }).id).toBe(
      "stock-prices",
    )
  })
})

describe("every built-in tile id is reserved", () => {
  test("BUILTIN_APP_LABELS ⊆ RESERVED_IDS", () => {
    // The defect class, stated forward: adding a tile is what makes an id squattable, and adding a
    // tile is done in `builtins.tsx` + `app-label.ts`, nowhere near either reserved list. `debug`
    // reached production that way. Superset, not equality: `processes` is reserved without being a
    // tile because it is a route, and reserving more than we render is free.
    const unreserved = tiles!.filter((id) => !core!.includes(id) || !app!.includes(id))
    expect(
      unreserved,
      [
        "A built-in home tile's id is not reserved.",
        "A plugin or an agent can register an app under that id and shadow the built-in.",
        `Add it to RESERVED_IDS in BOTH ${CORE} and ${APP}.`,
      ].join("\n"),
    ).toEqual([])
  })

  test("debug specifically", () => {
    // Named on its own because it is the reason this file exists, and because the Debug app is the
    // surface a user reaches when everything else has already failed.
    expect(tiles).toContain("debug")
    expect(core).toContain("debug")
    expect(app).toContain("debug")
  })
})

describe("the readers actually bite (negative control)", () => {
  test("a divergence and a missing tile are both reported", () => {
    const synthetic = 'const RESERVED_IDS = new Set([\n  "chats",\n  "notes",\n])'
    expect(reservedIn(synthetic)).toEqual(["chats", "notes"])
    // The state the tree was in this morning: a tile the reserved list does not carry.
    expect(["chats", "notes", "debug"].filter((id) => !reservedIn(synthetic)!.includes(id))).toEqual(["debug"])
    // …and the mirror comparison on two lists that differ by one entry.
    const other = reservedIn('const RESERVED_IDS = new Set([\n  "chats",\n  "debug",\n])')!
    expect(other.filter((id) => !reservedIn(synthetic)!.includes(id))).toEqual(["debug"])
    expect(reservedIn(synthetic)!.filter((id) => !other.includes(id))).toEqual(["notes"])
  })

  test("a declaration the reader cannot find reports undefined rather than an empty list", () => {
    expect(reservedIn("const OTHER = new Set([])")).toBeUndefined()
    expect(builtinTileIds("export const OTHER = {}")).toBeUndefined()
    // The tile reader must see quoted keys (`"memory-graph"`) and bare ones alike.
    const labels = [
      "export const BUILTIN_APP_LABELS = {",
      '  chats: { name: "Chats", subtitle: "s" },',
      '  "memory-graph": { name: "M", subtitle: "s" },',
      "} as const satisfies Record<string, never>",
    ].join("\n")
    expect(builtinTileIds(labels)).toEqual(["chats", "memory-graph"])
  })
})
