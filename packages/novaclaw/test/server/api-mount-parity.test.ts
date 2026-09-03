import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * Serve parity — every API the published document is composed from is MOUNTED, exactly once.
 *
 * `HttpApiBuilder.layer(api)` leaves an unsatisfied requirement for a GROUP whose handler layer is
 * missing, and `createRoutes`'s declared type turns that into a compile error — so group → handler
 * is mechanical. The level above it was convention: nothing checked that each `addHttpApi(…)`
 * member of `NovaClawHttpApi` (`api.ts`) has a builder in `server.ts` and that the builder is in
 * `createRoutes`'s `Layer.mergeAll`. A fifth `.addHttpApi(FooApi)` would be published in `/doc` and
 * served by nobody while every one of Foo's own unit tests passed. Ruling 11's adversary asked for
 * exactly this test; it did not exist until 2026-09-03.
 *
 * A SOURCE scan, like `legacy-path-ledger`, because a `Layer` does not expose the API it was built
 * from: the mount list is only legible in the file that writes it.
 */
const HTTPAPI = path.resolve(import.meta.dir, "../../src/server/routes/instance/httpapi")
const api = fs.readFileSync(path.join(HTTPAPI, "api.ts"), "utf8")
const server = fs.readFileSync(path.join(HTTPAPI, "server.ts"), "utf8")

/** The members of `NovaClawHttpApi`, in declaration order. */
const composed = (() => {
  const start = api.indexOf("export const NovaClawHttpApi")
  const end = api.indexOf(".annotate(", start)
  expect(start, "api.ts no longer declares NovaClawHttpApi").toBeGreaterThan(-1)
  return [...api.slice(start, end).matchAll(/\.addHttpApi\((\w+)\)/g)].map((m) => m[1]!)
})()

/**
 * The expression an API name is mounted under. `ServerApi` is declared AS `runtimeApi()` and mounted
 * by that same call — one value in two spellings, which is the whole point of that declaration.
 */
const mountedAs = (name: string): string => {
  const alias = api.match(new RegExp(`export const ${name}\\b[^=]*= (\\w+\\(\\))`))
  return alias?.[1] ?? name
}

/** `const <routes> = HttpApiBuilder.layer(<expr>)` — the builder for each mounted expression. */
const builders = new Map<string, string>()
for (const m of server.matchAll(/const (\w+) = HttpApiBuilder\.layer\(([\w().]+)\)/g)) builders.set(m[2]!, m[1]!)

/** Every identifier inside `createRoutes`'s `Layer.mergeAll(…)`, following one level of `x = y.pipe(` aliasing. */
const merged = (() => {
  const fn = server.indexOf("export function createRoutes(")
  const start = server.indexOf("Layer.mergeAll(", fn)
  const end = server.indexOf(").pipe(", start)
  expect(start, "server.ts createRoutes no longer merges its routes with Layer.mergeAll").toBeGreaterThan(fn)
  const direct = new Set(server.slice(start, end).match(/\b\w+\b/g) ?? [])
  // `instanceRoutes = instanceApiRoutes.pipe(…)`: the builder reaches the merge under another name.
  for (const m of server.matchAll(/const (\w+) = (\w+)\.pipe\(/g)) if (direct.has(m[1]!)) direct.add(m[2]!)
  return direct
})()

describe("serve parity: the published API is the mounted API", () => {
  test("the composition is what this test expects to be reading", () => {
    // Three since 2026-09-03: the legacy event API left with its route. A composition of one would
    // still be worth checking; a composition of zero is the scan reading the wrong file.
    expect(composed.length).toBeGreaterThanOrEqual(3)
    expect(builders.size).toBeGreaterThanOrEqual(3)
  })

  test("🔴 every member of NovaClawHttpApi has exactly one HttpApiBuilder in server.ts", () => {
    const unmounted = composed.filter((name) => !builders.has(mountedAs(name)))
    expect(unmounted, "published in /doc and served by nobody").toEqual([])
    for (const name of composed) {
      const expr = mountedAs(name)
      const count = [...server.matchAll(new RegExp(`HttpApiBuilder\\.layer\\(${expr.replace(/[().]/g, "\\$&")}\\)`, "g"))].length
      expect(count, `${name} is mounted ${count} times`).toBe(1)
    }
  })

  test("every builder for a composed API reaches createRoutes' Layer.mergeAll", () => {
    const orphaned = composed
      .map((name) => [name, builders.get(mountedAs(name))!] as const)
      .filter(([, routes]) => !merged.has(routes))
      .map(([name, routes]) => `${name} (built as ${routes}, never merged)`)
    expect(orphaned).toEqual([])
  })

  test("the scan bites (negative control)", () => {
    // A composition member with no builder is what the first test must catch.
    expect(builders.has("NoSuchApi")).toBe(false)
    expect(mountedAs("ServerApi")).toBe("runtimeApi()")
  })
})
