import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// An Effect `Context` is a Map keyed by the STRING passed to `Context.Service` / `Context.Reference` /
// `HttpApiMiddleware.Service`. Two different classes registered under one string are therefore ONE
// entry: provide both into the same context and whichever is provided last silently wins.
//
// TypeScript does not catch this. `Context.Service<Self, Shape>()(id)` produces a class whose instance
// type is `{ [ServiceTypeId], key: Id, Service: Shape }` — and TS is structural, so two classes with the
// same id and the same shape are mutually assignable. The requirement type-checks, the layer wiring
// type-checks, and the wrong implementation runs.
//
// That is not hypothetical. `@novaclaw/HttpApiSchemaError` was registered twice — once in
// `packages/protocol/src/middleware/schema-error.ts` (the ONE contract, todo.md ruling 11) and once in
// `packages/novaclaw/src/server/routes/instance/httpapi/middleware/schema-error.ts`, whose transform
// carries an extra `/api/`-path branch. `httpapi/server.ts` imports BOTH. They stayed correct only
// because each is provided into a separate `HttpApiBuilder.layer` scope; merging those scopes, or one
// copy-pasted `Layer.provide`, would have swapped the two behaviours with nothing failing. The second
// was renamed to `@novaclaw/ExperimentalHttpApiSchemaError` on 2026-07-28 (v0.2.0 PREP, Wave 1 / B4).
//
// Renaming one collision fixes one bug. THIS is what fixes the class of bug — todo.md's standing
// decision: *every invariant whose violation compiles green ships with a mechanical check, or the
// invariant does not exist.* The scan is deliberately STATIC (read the sources, boot nothing, import
// nothing from the app graph) so it stays hermetic and runs airgapped.
//
// Out of scope because they already fail loudly: `SystemContext.Key` ids (that registry rejects a
// duplicate at registration time) and route paths (a different contract — ruling 11).

const ROOT = path.join(import.meta.dir, "..", "..", "..")
const PACKAGES = path.join(ROOT, "packages")
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "gen", ".turbo", "build"])

/**
 * Every constructor that mints a `Context` key from a string literal.
 *
 * `ConfigService.Service` and `LayerMap.Service` are wrappers that forward to `Context.Service`, so
 * they mint keys in exactly the same namespace. A NEW wrapper missing from this list would be a hole
 * in the scan — which is what `knows every service-key constructor in the tree` below guards.
 */
const KEY_CONSTRUCTORS = new Set([
  "Context.Service",
  "Context.Reference",
  "Context.Tag",
  "Context.GenericTag",
  "Effect.Service",
  "HttpApiMiddleware.Service",
  "ConfigService.Service",
  "LayerMap.Service",
])

/**
 * Registrations whose id is not a literal — i.e. sites this scan cannot resolve.
 *
 * Only generic FORWARDERS belong here: their callers are themselves scanned, so nothing is lost. Any
 * other entry is a real blind spot and must be fixed rather than listed.
 */
const DYNAMIC_ID_FORWARDERS = ["packages/novaclaw/src/effect/config-service.ts"]

/**
 * Collisions that exist TODAY and were not this change's to fix. A RATCHET, not an excuse: an entry
 * that stops colliding fails the test until it is deleted, so the list can only shrink.
 *
 * EMPTY as of 2026-07-28 (v0.2.0 PREP, Wave 1 / U3) — the last entry, `@novaclaw/ServerAuthConfig`,
 * was fixed by renaming the instance-side declaration to `@novaclaw/InstanceServerAuthConfig` (see
 * `the two server-auth configs hold distinct keys` below). Adding an entry here is admitting a live
 * shadowing bug: only do it when the fix genuinely belongs to another unit, and say which.
 */
const KNOWN_COLLISIONS: readonly string[] = []

type Registration = { readonly id: string; readonly file: string; readonly line: number; readonly ctor: string }

const sourceFiles = (() => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name))
        continue
      }
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path.join(dir, entry.name))
    }
  }
  walk(PACKAGES)
  return found
})()

const relative = (file: string) => path.relative(ROOT, file).replaceAll("\\", "/")

/**
 * Replace comment bodies with spaces, preserving length so offsets and line numbers stay valid.
 * String-aware, so a `//` inside a URL literal is not mistaken for a comment. Without this, a JSDoc
 * example and one prose mention of `Context.Reference` both read as registrations.
 */
function blankComments(text: string): string {
  const out = text.split("")
  let i = 0
  while (i < text.length) {
    const char = text.charAt(i)
    if (char === '"' || char === "'" || char === "`") {
      i++
      while (i < text.length) {
        if (text.charAt(i) === "\\") {
          i += 2
          continue
        }
        if (text.charAt(i) === char) {
          i++
          break
        }
        i++
      }
      continue
    }
    if (char === "/" && text.charAt(i + 1) === "/") {
      while (i < text.length && text.charAt(i) !== "\n") {
        out[i] = " "
        i++
      }
      continue
    }
    if (char === "/" && text.charAt(i + 1) === "*") {
      const end = text.indexOf("*/", i + 2)
      const stop = end === -1 ? text.length : end + 2
      for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " "
      i = stop
      continue
    }
    i++
  }
  return out.join("")
}

function skipSpace(text: string, index: number): number {
  let i = index
  while (i < text.length && /\s/.test(text.charAt(i))) i++
  return i
}

/** Skip a balanced `<...>` type-argument list; -1 when it does not open with `<` or never closes. */
function skipTypeArguments(text: string, index: number): number {
  if (text.charAt(index) !== "<") return -1
  let depth = 0
  for (let i = index; i < text.length; i++) {
    const char = text.charAt(i)
    if (char === "<") depth++
    else if (char === ">") {
      if (text.charAt(i - 1) === "=") continue // an arrow `=>` inside a type argument
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

const CONSTRUCTOR_PATTERN = new RegExp(
  `\\b(${[...KEY_CONSTRUCTORS].map((name) => name.replace(".", "\\.")).join("|")})\\b`,
  "g",
)

const registrations: Registration[] = []
/** Call sites whose id is not a string literal — the scan cannot see through them. */
const dynamicSites: string[] = []

for (const file of sourceFiles) {
  const raw = fs.readFileSync(file, "utf8")
  const text = blankComments(raw)
  CONSTRUCTOR_PATTERN.lastIndex = 0
  let match = CONSTRUCTOR_PATTERN.exec(text)
  for (; match !== null; match = CONSTRUCTOR_PATTERN.exec(text)) {
    let i = skipSpace(text, match.index + match[0].length)
    // Require an actual CALL. A type position (`Context.Service<I, S>` as a parameter type) and a
    // property access (`Context.Service.Shape`) are not registrations.
    if (text.charAt(i) === "<") {
      const afterTypeArguments = skipTypeArguments(text, i)
      if (afterTypeArguments === -1) continue
      i = skipSpace(text, afterTypeArguments)
    }
    if (text.charAt(i) !== "(") continue
    i = skipSpace(text, i + 1)
    if (text.charAt(i) === ")") {
      // The curried form: `Context.Service<Self, Shape>()("id")`.
      i = skipSpace(text, i + 1)
      if (text.charAt(i) !== "(") continue
      i = skipSpace(text, i + 1)
    }
    const quote = text.charAt(i)
    const close = quote === '"' || quote === "'" || quote === "`" ? text.indexOf(quote, i + 1) : -1
    if (close === -1) {
      dynamicSites.push(relative(file))
      continue
    }
    registrations.push({
      id: raw.slice(i + 1, close),
      file: relative(file),
      line: text.slice(0, match.index).split("\n").length,
      ctor: match[0],
    })
  }
}

const byId = new Map<string, Registration[]>()
for (const registration of registrations) {
  const existing = byId.get(registration.id)
  if (existing) existing.push(registration)
  else byId.set(registration.id, [registration])
}

const collisions = [...byId.entries()].filter(([, sites]) => sites.length > 1)

describe("Context key uniqueness", () => {
  test("the scan actually found the tree", () => {
    // Guards the guard: a broken walk or a broken matcher makes every assertion below vacuously true.
    // Measured 2026-07-28: 2176 files, 177 registrations, 176 distinct ids.
    expect(sourceFiles.length).toBeGreaterThan(1000)
    expect(registrations.length).toBeGreaterThan(150)
    // Both call shapes must be reachable: the curried `Context.Service<S>()("id")` and the direct
    // `Context.Reference<T>("id", …)`.
    const constructorsSeen = new Set(registrations.map((entry) => entry.ctor))
    expect(constructorsSeen.has("Context.Service")).toBe(true)
    expect(constructorsSeen.has("Context.Reference")).toBe(true)
    expect(constructorsSeen.has("HttpApiMiddleware.Service")).toBe(true)
    expect([...constructorsSeen].filter((name) => !KEY_CONSTRUCTORS.has(name))).toEqual([])
  })

  test("knows every service-key constructor in the tree", () => {
    // A new wrapper around `Context.Service` (as `ConfigService.Service` is) would mint keys in the
    // same namespace while being invisible to the scan above. Catch it at the declaration site.
    const declared = new Set<string>()
    for (const file of sourceFiles) {
      const text = blankComments(fs.readFileSync(file, "utf8"))
      for (const declaration of text.matchAll(
        /\bextends\s+([A-Za-z_$][\w$]*\.(?:Service|Tag|GenericTag|Reference))\b/g,
      ))
        declared.add(declaration[1])
    }
    expect(declared.size).toBeGreaterThan(0)
    // If this fails, ADD the new constructor to KEY_CONSTRUCTORS — do not delete it from here.
    expect([...declared].filter((name) => !KEY_CONSTRUCTORS.has(name)).sort()).toEqual([])
  })

  test("every service key is a literal the scan can read", () => {
    // A computed id is a blind spot. Only generic forwarders may be listed, because their CALLERS are
    // scanned in their place.
    expect([...new Set(dynamicSites)].sort()).toEqual([...DYNAMIC_ID_FORWARDERS].sort())
  })

  test("no two implementations share a Context key", () => {
    const unexpected = collisions
      .filter(([id]) => !KNOWN_COLLISIONS.includes(id))
      .map(([id, sites]) => `${id} <- ${sites.map((site) => `${site.file}:${site.line} (${site.ctor})`).join(", ")}`)
      .sort()
    // Two classes under one id are ONE context entry: the later provide silently shadows the earlier,
    // and TypeScript cannot see it. Give the newer one its own id.
    expect(unexpected).toEqual([])
  })

  test("the known-collision ledger can only shrink", () => {
    // A fixed collision must be DELETED from KNOWN_COLLISIONS, never left to rot into a lie about the
    // tree. If this fails saying an entry is missing, that entry is already fixed — remove it.
    const stillColliding = KNOWN_COLLISIONS.filter((id) => (byId.get(id)?.length ?? 0) > 1)
    // Spread to a mutable copy: `toEqual` takes `string[]`, and the ledger is `readonly` on purpose.
    expect(stillColliding).toEqual([...KNOWN_COLLISIONS])
  })

  test("the two schema-error middlewares hold distinct keys", () => {
    // The specific regression this file was written for (v0.2.0 PREP Wave 1 / B4). Named explicitly so
    // a re-collision reads as itself rather than as an anonymous duplicate.
    const protocolSites = byId.get("@novaclaw/HttpApiSchemaError") ?? []
    const instanceSites = byId.get("@novaclaw/ExperimentalHttpApiSchemaError") ?? []
    expect(protocolSites.map((entry) => entry.file)).toEqual(["packages/protocol/src/middleware/schema-error.ts"])
    expect(instanceSites.map((entry) => entry.file)).toEqual([
      "packages/novaclaw/src/server/routes/instance/httpapi/middleware/schema-error.ts",
    ])
  })

  test("the two server-auth configs hold distinct keys", () => {
    // The second collision this file caught (v0.2.0 PREP Wave 1 / U3). `packages/server`'s middleware
    // yields ITS tag; `httpapi/server.ts` used to satisfy that requirement with the instance package's
    // class, which worked only because both shapes are `{ password: Option<string>, username: string }`.
    // Named explicitly so a re-collision reads as itself rather than as an anonymous duplicate.
    const serverSites = byId.get("@novaclaw/ServerAuthConfig") ?? []
    const instanceSites = byId.get("@novaclaw/InstanceServerAuthConfig") ?? []
    expect(serverSites.map((entry) => entry.file)).toEqual(["packages/server/src/auth.ts"])
    expect(instanceSites.map((entry) => entry.file)).toEqual(["packages/novaclaw/src/server/auth.ts"])
  })
})
