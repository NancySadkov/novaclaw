import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * **`Workspace.layer`'s requirements are mirrored by hand, and this is what makes the mirrors true.**
 *
 * ⚠️ Why a guard and not a comment. `Workspace.layer` acquires its services with `yield*` inside a
 * `Layer.effect`; anything that builds that layer directly has to provide every one of them. Three
 * separate lists say what those are, and none of them lives in the file that decides it — the defect
 * class that compiles green (todo.md, standing decision 2: an invariant whose violation compiles green
 * ships with a mechanical check, or the invariant does not exist).
 *
 * It has already fired. When `SessionScheduler.Service` was added to `Workspace.layer` (v0.2.0 PREP,
 * Wave 1), `test/fixture/workspace.ts` failed at RUNTIME — `Service not found`, 17 tests across three
 * suites — and `test/plugin/workspace-adapter.test.ts` failed only under `tsgo`. Both were patched by
 * hand. Nothing prevented the fifth occurrence, and the fixture already carried a comment saying so.
 *
 * The fix has two halves, and this file is the mechanical one:
 *   · **Half one — delete a mirror.** The two TEST assemblies were collapsed onto the single
 *     parameterised `workspaceLayerWithRuntimeFlags` fixture. `only one hand assembly` below is what
 *     keeps a second one from being reborn.
 *   · **Half two — check what is left.** This scan reads `Workspace.layer`'s prologue off disk and
 *     compares it against the remaining hand-maintained provide lists, failing in BOTH directions: a
 *     ninth requirement that nobody provided, and a provide that no longer corresponds to a
 *     requirement.
 *
 * ⚠️ Deliberately out of scope: `Workspace.node`'s `deps`. That list is already checked BY THE TYPE —
 * `packages/core/src/effect/layer-node.ts` types `deps` as
 * `Items & CheckDependencies<Implementation, NoInfer<Items>>`, which resolves to
 * `{ readonly "Missing dependencies": … }` on a gap. `the compile-time guard on Workspace.node`
 * below pins that constraint so this file's claim about it cannot quietly become false, and
 * cross-checks the deps list, but the type is the real check.
 *
 * Also out of scope: the ~two dozen other `src` modules that declare both a `defaultLayer` and a `node`
 * (29 files as of 2026-07-28), and the other `test` files that re-assemble a src layer by hand.
 * `Workspace` is the worst instance and the one that actually broke; this guard's scope is stated
 * explicitly so nobody mistakes it for a tree-wide one.
 *
 * The scan is STATIC and hermetic — it reads sources with `node:fs`, boots nothing and imports nothing
 * from the app graph, so it runs airgapped and cannot be defeated by a layer that fails to build.
 */

/** `packages/novaclaw/test/control-plane` → `packages/novaclaw`. */
const PKG = path.resolve(import.meta.dir, "..", "..")
/** …→ `packages` → the app repo root. */
const ROOT = path.resolve(PKG, "..", "..")

const WORKSPACE_SRC = path.join(PKG, "src", "control-plane", "workspace.ts")
const FIXTURE = path.join(PKG, "test", "fixture", "workspace.ts")
const LAYER_NODE = path.join(ROOT, "packages", "core", "src", "effect", "layer-node.ts")
const TEST_TREE = path.join(PKG, "test")

/** This file. It quotes every shape it hunts, so without the exclusion it is its own first offender. */
const SELF = "packages/novaclaw/test/control-plane/workspace-layer-mirrors.test.ts"

// ── reading ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Replace comment bodies with spaces, preserving length and newlines so line structure survives.
 * String-aware, so a `//` inside a URL literal is not mistaken for a comment. Without this, the prose
 * ABOUT this pattern — which every one of these files carries — reads as the pattern itself.
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

const read = (file: string) => blankComments(fs.readFileSync(file, "utf8"))

/**
 * The body of one top-level `export const <name> = …`, up to the next column-0 declaration. Returns ""
 * when the header is not found — every caller asserts on that, so a renamed export fails loudly rather
 * than silently scanning nothing.
 */
function declarationBody(text: string, header: string): string {
  const start = text.indexOf(header)
  if (start === -1) return ""
  const rest = text.slice(start + header.length)
  const end = rest.search(/\n(?:export )?(?:const|function|class|type|interface) /)
  return end === -1 ? rest : rest.slice(0, end)
}

/** Index of the `)` matching the `(` at `open`; -1 when unbalanced. */
function closingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const char = text.charAt(i)
    if (char === "(") depth++
    else if (char === ")" && --depth === 0) return i
  }
  return -1
}

/** The argument text of every OUTERMOST `Layer.provide(…)` in a slice, in source order. */
function provideArguments(text: string): string[] {
  const marker = "Layer.provide("
  const out: string[] = []
  let cursor = 0
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
    if (at < cursor) continue // nested inside an argument already taken
    const open = at + marker.length - 1
    const close = closingParen(text, open)
    if (close === -1) continue
    out.push(text.slice(open + 1, close))
    cursor = close
  }
  return out
}

/** Drop `.pipe(…)` sub-expressions, so `X.defaultLayer.pipe(Layer.provide(Y))` reads as X alone. */
function withoutPipes(text: string): string {
  let out = text
  for (;;) {
    const at = out.indexOf(".pipe(")
    if (at === -1) return out
    const close = closingParen(out, at + ".pipe".length)
    if (close === -1) return out.slice(0, at)
    out = out.slice(0, at) + out.slice(close + 1)
  }
}

/** `Auth.defaultLayer` / `FetchHttpClient.layer` / `Worktree.appLayer` → the module identifier. */
const LAYER_TOKEN = /\b([A-Z][\w$]*)\.(?:defaultLayer|layer|appLayer)\b/g

/** Which modules a hand-maintained provide list actually provides, in source order. */
function providersIn(slice: string): string[] {
  return provideArguments(slice).flatMap((argument) =>
    [...withoutPipes(argument).matchAll(LAYER_TOKEN)].map((match) => match[1]!),
  )
}

/**
 * The services `Workspace.layer`'s prologue acquires.
 *
 * Deliberately narrow: a `const … = yield* <DottedTag>` statement at the layer body's own indentation,
 * with nothing after the tag. That is what a requirement looks like and nothing else does — it will not
 * match `yield* FiberMap.make<…>()` (a call), nor the `yield* InstanceStore.Service` nested ten columns
 * deep inside `runInWorkspace` (which is discharged locally, not a layer requirement).
 *
 * ⚠️ Because it is narrow it could match NOTHING after a refactor, which would make every check below
 * vacuous. `the prologue this table was written against` asserts the exact expected set, so a change of
 * syntax fails loudly instead of passing silently.
 */
const PROLOGUE_ACQUIRE = /^ {4}const (?:\{[^}\n]*\}|[\w$]+) = yield\* ([A-Z][\w$]*(?:\.[A-Za-z][\w$]*)+)[ \t]*$/gm

const acquiredIn = (slice: string) => [...slice.matchAll(PROLOGUE_ACQUIRE)].map((match) => match[1]!)

// ── the table ───────────────────────────────────────────────────────────────────────────────────

/**
 * Every service `Workspace.layer` acquires, and the module that provides it.
 *
 * This is the ratchet's pivot: a requirement with no row fails, and a row with no requirement fails.
 * `node` is the spelling used in `Workspace.node`'s deps, which is checked by the TYPE — it is here so
 * the cross-check below reads as a table rather than as a second hidden list.
 */
const REQUIREMENTS: ReadonlyArray<{
  readonly tag: string
  readonly provider: string
  readonly node: string
}> = [
  { tag: "Auth.Service", provider: "Auth", node: "Auth.node" },
  // The platform HTTP client. Provided as `FetchHttpClient.layer` in every hand-maintained assembly;
  // the composition root uses the `httpClient` node from core's app-node-platform.
  { tag: "HttpClient.HttpClient", provider: "FetchHttpClient", node: "httpClient" },
  { tag: "EventV2Bridge.Service", provider: "EventV2Bridge", node: "EventV2Bridge.node" },
  { tag: "Vcs.Service", provider: "Vcs", node: "Vcs.node" },
  { tag: "RuntimeFlags.Service", provider: "RuntimeFlags", node: "RuntimeFlags.node" },
  { tag: "FSUtil.Service", provider: "FSUtil", node: "FSUtil.node" },
  // Added in Wave 1 — the requirement that broke both test mirrors and motivated this file.
  { tag: "SessionScheduler.Service", provider: "SessionScheduler", node: "SessionScheduler.node" },
  { tag: "Database.Service", provider: "Database", node: "Database.node" },
]

const EXPECTED_TAGS = REQUIREMENTS.map((entry) => entry.tag)
const EXPECTED_PROVIDERS = new Set(REQUIREMENTS.map((entry) => entry.provider))

const workspaceSource = read(WORKSPACE_SRC)
const layerBody = declarationBody(workspaceSource, "export const layer = Layer.effect(")
const defaultLayerBody = declarationBody(workspaceSource, "export const defaultLayer = layer.pipe(")
const nodeBody = declarationBody(workspaceSource, "export const node = LayerNode.make(")
const acquired = acquiredIn(layerBody)

/**
 * The hand-maintained lists that a ninth requirement would break **at runtime or not at all**.
 *
 * `Workspace.node` is not here: its `deps` is compile-checked (see the header), and re-listing it would
 * claim a check this file does not perform.
 */
const MIRRORS: ReadonlyArray<{ readonly name: string; readonly slice: string; readonly caught: string }> = [
  {
    name: "Workspace.defaultLayer (src/control-plane/workspace.ts)",
    slice: defaultLayerBody,
    caught: "only indirectly, when its consumer src/effect/app-runtime.ts fails to typecheck",
  },
  {
    name: "workspaceLayerWithRuntimeFlags (test/fixture/workspace.ts)",
    slice: read(FIXTURE),
    caught: "NOT AT COMPILE TIME — this list fails at runtime with `Service not found`",
  },
]

// ── the sweep ───────────────────────────────────────────────────────────────────────────────────

const testFiles = (() => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full)
        continue
      }
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(full)
    }
  }
  walk(TEST_TREE)
  return found.map((file) => ({
    name: path.relative(ROOT, file).replaceAll("\\", "/"),
    text: read(file),
  }))
})()

describe("the sweep", () => {
  test("actually found the sources it reasons about", () => {
    // A moved file, a renamed export or a bad walk would silently empty every check below.
    expect(workspaceSource.length).toBeGreaterThan(10_000)
    expect(layerBody.length, "`export const layer = Layer.effect(` not found in workspace.ts").toBeGreaterThan(5_000)
    expect(defaultLayerBody.length, "`export const defaultLayer = layer.pipe(` not found").toBeGreaterThan(100)
    expect(nodeBody.length, "`export const node = LayerNode.make(` not found").toBeGreaterThan(50)
    expect(testFiles.length, "the test-tree walk found nothing").toBeGreaterThan(100)
    expect(testFiles.map((file) => file.name)).toContain("packages/novaclaw/test/fixture/workspace.ts")
    for (const mirror of MIRRORS) expect(mirror.slice.length, `${mirror.name} is empty`).toBeGreaterThan(100)
  })

  test("the prologue this table was written against", () => {
    // THE self-check. The matcher is deliberately narrow, so a refactor of how `Workspace.layer`
    // acquires its services could make it match nothing and turn this whole file green-and-useless.
    // Asserting the exact set means that refactor fails HERE, loudly, instead of disarming the guard.
    //
    // If this fails with an EXTRA tag: `Workspace.layer` grew a requirement — add its row to
    // REQUIREMENTS and provide it in every mirror. With a MISSING tag: a requirement went away — drop
    // its row. With an empty list: the matcher no longer understands the source; fix the matcher.
    expect(acquired).toEqual(EXPECTED_TAGS)
  })
})

describe("every hand-maintained mirror covers every requirement", () => {
  for (const mirror of MIRRORS) {
    test(`${mirror.name} provides all ${REQUIREMENTS.length} — missing ones are caught ${mirror.caught}`, () => {
      const provided = new Set(providersIn(mirror.slice))
      const missing = REQUIREMENTS.filter((entry) => !provided.has(entry.provider)).map(
        (entry) => `${entry.tag} (provide ${entry.provider})`,
      )
      expect(missing).toEqual([])
    })

    test(`${mirror.name} carries no provide that is not a requirement`, () => {
      // The other direction of the ratchet. A provide left behind after `Workspace.layer` stopped
      // needing it is dead weight that reads as a requirement — which is how `InstanceStore` and
      // `InstanceBootstrap` sat in both test mirrors while `defaultLayer` correctly omitted them.
      const extra = [...new Set(providersIn(mirror.slice))].filter((name) => !EXPECTED_PROVIDERS.has(name)).sort()
      expect(extra).toEqual([])
    })
  }
})

describe("only one hand assembly of Workspace.layer exists", () => {
  test("every suite that needs it goes through test/fixture/workspace.ts", () => {
    // Half one of the fix, pinned. Two copies of a list nobody can typecheck is how this broke; a
    // third would break it again. Import `workspaceLayerWithRuntimeFlags` instead — it takes the
    // RuntimeFlags overrides that were the only real difference between the two former copies.
    const assemblers = testFiles
      .filter((file) => file.name !== SELF)
      .filter((file) => /\bWorkspace\.layer\b/.test(file.text))
      .map((file) => file.name)
      .sort()
    expect(assemblers).toEqual(["packages/novaclaw/test/fixture/workspace.ts"])
  })

  test("the fixture builds Workspace.layer, not defaultLayer — otherwise this guard is pointless", () => {
    // If the fixture ever switches to `Workspace.defaultLayer` it inherits the provides and needs no
    // mirror at all. That would be a fine outcome, but it must be a DECISION: delete this file's
    // fixture rows rather than leaving them asserting over a list that no longer matters.
    const fixture = MIRRORS.find((mirror) => mirror.name.includes("test/fixture"))!
    expect(fixture.slice).toContain("Workspace.layer.pipe(")
  })
})

describe("the compile-time guard on Workspace.node", () => {
  const layerNode = read(LAYER_NODE)

  test("layer-node.ts still rejects a deps list with a gap", () => {
    // This file claims `Workspace.node` needs no runtime check because the TYPE catches it. If that
    // constraint is ever loosened the claim becomes false, and a fourth unchecked mirror appears with
    // nothing saying so. Pin the two halves: the constraint on `deps`, and the error branch.
    expect(layerNode).toContain("readonly deps: Items & CheckDependencies<Implementation, NoInfer<Items>>")
    expect(layerNode).toContain('{ readonly "Missing dependencies": Missing<Layer.Services<Implementation>')
  })

  test("its deps list agrees with the requirement table", () => {
    const deps = nodeBody.slice(nodeBody.indexOf("deps: ["))
    const listed = deps
      .slice(deps.indexOf("[") + 1, deps.indexOf("]"))
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    expect(listed.sort()).toEqual(REQUIREMENTS.map((entry) => entry.node).sort())
  })
})

// ── negative controls ───────────────────────────────────────────────────────────────────────────

describe("the matchers actually bite", () => {
  const prologue = [
    "  Service,",
    "  Effect.gen(function* () {",
    "    const auth = yield* Auth.Service",
    "    const http = yield* HttpClient.HttpClient",
    "    const { db } = yield* Database.Service",
    "    const ninth = yield* Something.Service",
    "    const syncFibers = yield* FiberMap.make<WorkspaceV2.ID, void, SyncLoopError>()",
    "    const inner = Effect.gen(function* () {",
    "      const store = yield* InstanceStore.Service",
    "    })",
    "  }),",
  ].join("\n")

  test("a ninth requirement is seen; a call, a nested yield and a comment are not", () => {
    expect(acquiredIn(prologue)).toEqual([
      "Auth.Service",
      "HttpClient.HttpClient",
      "Database.Service",
      "Something.Service",
    ])
    // `FiberMap.make<…>()` is a construction, not an acquisition — it must never enter the list.
    expect(acquiredIn(prologue)).not.toContain("FiberMap.make")
    // Nor may the local `InstanceStore.Service` inside `runInWorkspace`, which is discharged by its
    // own `Effect.provide` and is NOT a layer requirement.
    expect(acquiredIn(prologue)).not.toContain("InstanceStore.Service")
    // Comments are blanked, so prose about the pattern is not the pattern.
    expect(acquiredIn(blankComments("    // const ghost = yield* Ghost.Service\n"))).toEqual([])
  })

  test("the provide extractor reads the head of a pipe and ignores what is nested inside it", () => {
    expect(providersIn("x.pipe(Layer.provide(Auth.defaultLayer), Layer.provide(FetchHttpClient.layer))")).toEqual([
      "Auth",
      "FetchHttpClient",
    ])
    expect(providersIn("Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: true }))")).toEqual(["RuntimeFlags"])
    expect(providersIn("Layer.provide(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrapLayer)))")).toEqual([
      "InstanceStore",
    ])
    expect(providersIn("Layer.provide([Config.defaultLayer, Format.defaultLayer])")).toEqual(["Config", "Format"])
    // Silent on the correct thing: a layer that is merged, not provided, is not a mirror entry.
    expect(providersIn("Layer.mergeAll(Auth.defaultLayer, Database.defaultLayer)")).toEqual([])
  })

  test("missing and extra are both reachable, on synthetic lists", () => {
    // The real assertions above expect EMPTY arrays, which alone cannot show a non-empty one is
    // reachable. Drive both computations on a list that is wrong in each direction.
    const short = "Layer.provide(Auth.defaultLayer)"
    const providedShort = new Set(providersIn(short))
    expect(REQUIREMENTS.filter((entry) => !providedShort.has(entry.provider)).map((entry) => entry.provider)).toEqual(
      REQUIREMENTS.filter((entry) => entry.provider !== "Auth").map((entry) => entry.provider),
    )

    const stale = "Layer.provide(InstanceStore.defaultLayer)Layer.provide(InstanceBootstrap.defaultLayer)"
    expect([...new Set(providersIn(stale))].filter((name) => !EXPECTED_PROVIDERS.has(name)).sort()).toEqual([
      "InstanceBootstrap",
      "InstanceStore",
    ])
  })
})
