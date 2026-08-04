import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * **Every suite that composes `httpapi-layer.ts` runs on the SHARED memo map**, and this is the check
 * that makes that sentence true rather than aspirational.
 *
 * ⚠️ Why a guard and not a comment. `testEffect(...)` and `testEffectShared(...)` differ by six
 * characters, both compile, both go green, and the difference is invisible in a diff review — a
 * suite that drifts back to `testEffect` keeps passing while quietly rebuilding
 * `LayerNode.compile(app)` (~50 global nodes, the messenger stack, `CalendarScheduler`,
 * `Observability`, the catalog/recipe seeds and `Database` with its migration `apply()`) once per
 * test. That is the defect class todo.md ruling 1 names: an invariant whose violation compiles green
 * ships with a mechanical check or it does not exist.
 *
 * ⚠️ There is a CORRECTNESS half too, and it is the more important one. Under
 * `test/preload.ts`'s `NOVACLAW_DB=":memory:"` a database is identified by its LAYER BUILD, so an
 * isolated build gives a suite a PRIVATE database — while `test/fixture/db.ts`'s `resetDatabase()`
 * sweeps the one behind the shared memo map (`fixture.ts` → `onServer()`). An `httpApiLayer` suite on
 * `testEffect` is therefore reset in a database it does not read, and shares no Bus/Session identity
 * with `Server.Default()`. `testEffectShared` is what makes those two agree.
 *
 * ⚠️ **This file lives under `test/server/` on purpose.** `server` is one of
 * `PROMOTED_NOVACLAW_SUBDIRS` in `script/test.ts`, i.e. a run unit in the DEFAULT tier. Anywhere else
 * under `packages/novaclaw/test/` it would be `--full`-only, and a ratchet nobody runs is not a
 * ratchet.
 */

/** `packages/novaclaw/test/server` → `test` → `novaclaw` → `packages` → repo root. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..")

/** The one directory `httpapi-layer.ts` can be imported from with a relative specifier. */
const SCAN_DIR = path.join(ROOT, "packages/novaclaw/test/server")

/**
 * This file itself. It quotes every shape it hunts for, so without this it would be its own first
 * offender. Excluded by name rather than by a marker comment, because a marker in a source file is
 * an opt-out anyone could paste.
 */
const SELF = "packages/novaclaw/test/server/httpapi-shared-run-ledger.test.ts"

/** The runner module, checked separately: the guard above is worthless if the mechanism is gone. */
const RUNNER = "packages/novaclaw/test/lib/effect.ts"

interface Source {
  /** Repo-relative, posix-separated — the name the ledger and the failures speak. */
  readonly name: string
  /** CODE ONLY. Comments are stripped, so a file that merely EXPLAINS the old shape is clean. */
  readonly text: string
}

/** The comment stripper the sibling ledgers use — `//` must not eat the `//` in a URL. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

function collect(dir: string): Source[] {
  const out: Source[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue
    const name = path.relative(ROOT, path.join(dir, entry.name)).replaceAll("\\", "/")
    if (name === SELF) continue
    out.push({ name, text: stripComments(fs.readFileSync(path.join(dir, entry.name), "utf8")) })
  }
  return out
}

const sources = collect(SCAN_DIR)
const runner: Source = {
  name: RUNNER,
  text: stripComments(fs.readFileSync(path.join(ROOT, RUNNER), "utf8")),
}

/**
 * A file "consumes" the layer when it names `httpApiLayer` in CODE. Deliberately not "imports
 * `./httpapi-layer`": `request`/`requestInDirectory` come from the same module and carry no graph
 * cost, so keying on the import would sweep in files that only make requests against someone else's
 * server.
 */
const consumesHttpApiLayer = (file: Source) => /\bhttpApiLayer\b/.test(file.text)

/**
 * The isolated runner, spelled as a CALL. `testEffect(` cannot match `testEffectShared(` — the
 * paren is what separates them — so this is the whole test.
 */
const usesIsolatedRunner = (file: Source) => /\btestEffect\s*\(/.test(file.text)
const usesSharedRunner = (file: Source) => /\btestEffectShared\s*\(/.test(file.text)

/**
 * ─── the ledger ────────────────────────────────────────────────────────────────────────────────────
 *
 * Every `httpApiLayer` consumer allowed to keep the ISOLATED runner, and WHY.
 *
 * ⚠️ Adding an entry here is a decision with a cost — one full rebuild of the instance HTTP graph per
 * test, on a gate the owner has capped at 5 minutes (todo/test-speed.md). A file belongs here only
 * when a FRESH graph is its subject (a build counter, a boot sequence, a migration from empty), not
 * when sharing merely felt risky. State which of those it is.
 */
const LEDGER = new Map<string, string>([
  [
    "packages/novaclaw/test/server/httpapi-experimental.test.ts",
    "PROVISIONS A FILE-SPECIFIC CONFIG DOCUMENT (`mcp.servers.demo`) and there is no undo for it. " +
      "`tmpdirScoped({ config })` writes through `applyConfigScoped`, which provisions into the " +
      "AMBIENT memo map and — unlike the async `tmpdir()` flavour — records nothing in fixture.ts's " +
      "`provisioned` ledger. Isolated that write lands in a private `:memory:` database and dies with " +
      "the test; SHARED it lands in the store the whole process reads, and `sweepDataPlane` " +
      "deliberately does not clear the config plane. MEASURED 2026-07-29: converting this file alone " +
      "turned the four `mcp HttpApi` suites in httpapi-mcp.test.ts from FAIL to PASS — not because " +
      "they were fixed, but because they were reading THIS file's leaked `demo` server " +
      "(`bun test httpapi-experimental.test.ts httpapi-mcp.test.ts` → 3 pass/4 fail isolated, " +
      "7 pass/0 fail shared). Un-ledger it when `applyConfigScoped` gains the undo bookkeeping.",
  ],
  [
    "packages/novaclaw/test/server/httpapi-session-v2.test.ts",
    "Same class as httpapi-experimental, and worse in shape: it provisions " +
      "`testProviderConfig(llm.url)`, i.e. `providers.test.api.url` pointing at a TestLLMServer whose " +
      "port is different every test. The config stores MERGE rather than replace, so on the shared " +
      "map a later reader inherits a URL whose listener is gone — the exact hazard fixture.ts warns " +
      "about above `provisioned` ('the previous test's api.url survives the fold'). " +
      "⚠️ It also hits a SECOND obstacle worth knowing before anyone retries: its `withFakeLlm` does a " +
      "nested `Effect.provide(TestLLMServer.layer)`, and a nested provide inherits the ambient memo " +
      "map, so under the shared runner the fake LLM resolves the PINNED `HttpRouter.layer` and dies " +
      "with `Method 'POST' already declared for route '/v1/chat/completions'` on the second test. " +
      "`Effect.provide(Layer.fresh(TestLLMServer.layer))` fixes that half (measured); only the config " +
      "undo is missing.",
  ],
])

const offenders = (files: readonly Source[]): string[] =>
  files
    .filter((file) => consumesHttpApiLayer(file) && !LEDGER.has(file.name))
    .filter((file) => usesIsolatedRunner(file))
    .map((file) => `${file.name} → testEffect( on an httpApiLayer graph; use testEffectShared(`)
    .sort()

/**
 * The mechanism, pinned by the three properties that make `testEffectShared` mean anything. A
 * rewrite that kept the export and dropped any one of them would leave every assertion above green
 * while restoring the per-test rebuild.
 *
 *  · `memoMap` — the SHARED process-wide map (`@novaclaw/core/effect/memo-map`), the one
 *    `Server.Default()` and `fixture.ts`'s `onServer()` build through. A private map shares nothing.
 *  · `Scope.makeUnsafe()` — the never-closed observer. ⚠️ Without it the map shares nothing either:
 *    `MemoMap` entries are REFERENCE COUNTED (`Layer.ts` → `memoMapBuild`), so a build whose scope is
 *    then closed drops the entry back out of the map. This is the property a reviewer is most likely
 *    to "simplify" away, because the code reads fine without it.
 *  · `sharedRunFor(layer)` reached from `testEffectShared` — the wiring itself.
 */
const MECHANISM_MARKERS = ["memoMap", "Scope.makeUnsafe()", "pinLayer", "sharedRunFor(layer)"] as const

const missingMechanism = (text: string): string[] => MECHANISM_MARKERS.filter((marker) => !text.includes(marker))

describe("the sweep", () => {
  test("actually has test/server to look at", () => {
    // A mistyped root or a moved directory would empty the sweep and turn every assertion below into
    // a tautology.
    expect(sources.length).toBeGreaterThan(30)
    expect(sources.filter(consumesHttpApiLayer).length).toBeGreaterThanOrEqual(10)
  })

  test("reaches the files that compose the layer, and the one that defines it", () => {
    const consumers = new Set(sources.filter(consumesHttpApiLayer).map((file) => file.name))
    for (const name of [
      "packages/novaclaw/test/server/httpapi-workspace.test.ts",
      "packages/novaclaw/test/server/httpapi-event.test.ts",
      "packages/novaclaw/test/server/httpapi-sync.test.ts",
      "packages/novaclaw/test/server/project-copy.test.ts",
      "packages/novaclaw/test/server/httpapi-layer.ts",
    ])
      expect(consumers, `${name} is not in the sweep`).toContain(name)
  })
})

describe("httpApiLayer suites run on the shared memo map", () => {
  test("no unledgered consumer uses the isolated runner", () => {
    // Take `testEffectShared(...)` from `test/lib/effect.ts`. If a FRESH graph is genuinely this
    // file's subject, add an entry to LEDGER above WITH ITS REASON, and expect that reason to be read.
    expect(offenders(sources)).toEqual([])
  })

  test("the ledger can only SHRINK — a converted or vanished entry must be deleted from it", () => {
    const stale: string[] = []
    for (const name of LEDGER.keys()) {
      const file = sources.find((item) => item.name === name)
      if (file === undefined) {
        stale.push(`${name} (no longer exists — drop the ledger entry)`)
        continue
      }
      if (!consumesHttpApiLayer(file)) stale.push(`${name} (no longer composes httpApiLayer — drop the ledger entry)`)
      else if (!usesIsolatedRunner(file)) stale.push(`${name} (already on testEffectShared — drop the ledger entry)`)
    }
    expect(stale).toEqual([])
  })

  test("the converted suites really do reach the shared runner", () => {
    // The other direction of the same property: `offenders` only proves nobody says `testEffect(`.
    // A file that says NEITHER would pass that and run on nothing at all.
    const silent = sources
      .filter((file) => consumesHttpApiLayer(file) && !LEDGER.has(file.name))
      .filter((file) => file.name !== "packages/novaclaw/test/server/httpapi-layer.ts")
      .filter((file) => !usesSharedRunner(file) && !usesIsolatedRunner(file))
      .map((file) => `${file.name} (composes httpApiLayer but names no runner)`)
      .sort()
    // `httpapi-shell-offline.test.ts` builds the layer directly in a `test()` as well — that is fine,
    // it also declares a runner. A file with NO runner at all is either dead or hand-rolling one.
    expect(silent).toEqual([])
  })

  test("the runner still PINS the graph in the shared memo map", () => {
    expect(missingMechanism(runner.text), `${RUNNER} no longer pins the shared graph`).toEqual([])
  })
})

describe("the guard actually bites (negative control)", () => {
  test("it separates the two runner spellings", () => {
    expect(usesIsolatedRunner({ name: "x", text: "const it = testEffect(httpApiLayer)" })).toBe(true)
    // The six-character drift this whole file exists for: `testEffectShared(` must NOT read as
    // `testEffect(`, or every converted suite would land straight back in the offender list.
    expect(usesIsolatedRunner({ name: "x", text: "const it = testEffectShared(httpApiLayer)" })).toBe(false)
    expect(usesSharedRunner({ name: "x", text: "const it = testEffectShared(httpApiLayer)" })).toBe(true)
    // An import line alone is not a call, and `testEffectShared` is imported by name.
    expect(usesIsolatedRunner({ name: "x", text: `import { testEffectShared } from "../lib/effect"` })).toBe(false)
  })

  test("it separates a graph consumer from a mere request helper", () => {
    expect(consumesHttpApiLayer({ name: "x", text: `import { httpApiLayer } from "./httpapi-layer"` })).toBe(true)
    expect(consumesHttpApiLayer({ name: "x", text: `import { requestInDirectory } from "./httpapi-layer"` })).toBe(
      false,
    )
    // …and prose about the layer is code-clean, because comments are stripped.
    expect(consumesHttpApiLayer({ name: "x", text: stripComments("// uses httpApiLayer\nconst x = 1") })).toBe(false)
  })

  test("an unledgered offender is what the sweep reports", () => {
    // The real sweep asserts an EMPTY list, which alone cannot show a non-empty one is reachable.
    const synthetic: Source = {
      name: "packages/novaclaw/test/server/rogue.test.ts",
      text: "const it = testEffect(Layer.mergeAll(Database.defaultLayer, httpApiLayer))",
    }
    expect(offenders([synthetic])).toEqual([
      "packages/novaclaw/test/server/rogue.test.ts → testEffect( on an httpApiLayer graph; use testEffectShared(",
    ])
    // A ledgered file with the same body is silent — the ledger is the only way through.
    const ledgered = new Map(LEDGER)
    ledgered.set(synthetic.name, "synthetic")
    expect(
      [synthetic].filter((file) => consumesHttpApiLayer(file) && !ledgered.has(file.name)).map((file) => file.name),
    ).toEqual([])
  })

  test("a runner that stopped pinning is what the mechanism check reports", () => {
    // The regression the pin exists to catch: the map is still shared, the observer is gone, and
    // every entry drops back out of the map the moment the per-test scope closes.
    const regressed = `const sharedRun: Runner = (value, layer) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const ctx = yield* Layer.buildWithMemoMap(layer, memoMap, scope)
        yield* Scope.close(scope, Exit.void)
      })`
    expect(missingMechanism(regressed)).toEqual(["Scope.makeUnsafe()", "pinLayer", "sharedRunFor(layer)"])
    // …and a runner that dropped the shared map entirely.
    expect(missingMechanism("const run = (v, l) => Effect.provide(v, l)")).toEqual([...MECHANISM_MARKERS])
    // The real runner is the control in the other direction.
    expect(missingMechanism(runner.text)).toEqual([])
  })
})
