import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AgentJail } from "../agent-jail"
import {
  runJs,
  formatValue,
  resetRuntimeCache,
  resolveHardKillGraceMs,
  BOOT_TIMEOUT_MS,
  HARD_KILL_GRACE_MS,
  HARD_KILL_GRACE_FLOOR_MS,
  type JsRun,
  type JsRunOptions,
} from "./js-run"

// ─── the spawn seam ─────────────────────────────────────────────────────────────────────────────
//
// Wave 1 moved `js` OUT OF PROCESS to close the vm escape (see the header of js-run.ts) and this
// file never adapted. Measured 2026-07-28 with `--reporter=junit`: it started **63 child processes**
// and cost **18.5 s** of `core`'s 156 s — and roughly 21 of those children existed only to render a
// value, which one child renders just as well. Nothing failed. A pure assertion that spawns a
// process is indistinguishable from one that does not, except on the clock, so it is exactly the
// invariant-that-compiles-green class ruling 1 is about.
//
// So: EVERY snippet evaluation in this file goes through `evaluate`, and the ledger at the bottom
// counts what it started and pins the total exactly. Adding a child for a pure assertion now fails.
//
// ⚠️ The dominant cost in this file is NOT the spawns. It is one test — "a value whose getter never
// returns" — which waits `HARD_KILL_GRACE_MS` (js-run.ts, 8 s) because that constant has no test
// seam. Measured 2026-07-28: 8.226 s of a 14.0 s file. Fixing it means making the grace injectable,
// which is a change to js-run.ts, not to its tests.
let sandboxChildren = 0
const evaluate = (code: string, opts?: JsRunOptions): Promise<JsRun> => {
  sandboxChildren += 1
  return runJs(code, opts)
}

describe("runJs", () => {
  /**
   * Expressions whose GUEST rendering must equal the host `formatValue` of the same expression. The
   * guest formatter is a source-string twin of the exported host one, and a silent divergence
   * between them compiles green — so this is the pair that has to be checked, not asserted at.
   */
  const TWINNED_EXPRESSIONS = [
    "undefined",
    "null",
    "10n",
    "'hi'",
    "42",
    "true",
    "Symbol('s')",
    "(function foo(){})",
    "(function(){})",
    "[1,2,3]",
    "({ a: 1, b: 'two' })",
    "new Error('boom')",
    "({ big: 7n })",
    "NaN",
    "-0",
  ]

  /**
   * Cases with no host twin: `Decimal` exists only because decimal.js's SOURCE is evaluated inside
   * the sandbox, and `structuredClone` is a guest-realm shim (a bare realm has neither). Pinned to a
   * literal rendering, which also documents what the tool promises a model.
   */
  const GUEST_ONLY_CASES: ReadonlyArray<readonly [expression: string, rendered: string]> = [
    ["2n ** 64n", "18446744073709551616n"],
    ["new Decimal(1).dividedBy(8)", "0.125"],
    ["new Date(0).toISOString()", "1970-01-01T00:00:00.000Z"],
    ["(() => { const a = { n: [1, 2] }; const b = structuredClone(a); b.n.push(3); return a.n.length })()", "2"],
  ]

  test("renders every pure value in ONE child, and the guest formatter agrees with the host", async () => {
    // ⚠️ 21 children used to do this — six one-value tests plus a 15-iteration loop, ~76 ms each.
    // Collapsing them loses nothing, because `console.log` and the returned value pass through the
    // SAME guest formatter: the guest's `record()` and its `format()` both call `formatValue`, so a
    // log line IS the rendering those tests asserted on `r.result`. The cases that genuinely depend
    // on the process boundary (a fresh sandbox per call, the kill paths, the escape suite) are not
    // here — see the ledger at the bottom of the file for where every remaining child goes.
    const cases = [
      ...TWINNED_EXPRESSIONS.map((expression) => ({
        expression,
        rendered: formatValue(new Function(`return (${expression})`)()),
      })),
      ...GUEST_ONLY_CASES.map(([expression, rendered]) => ({ expression, rendered })),
      // multi-argument console.log joins each argument's own rendering with a single space
      { expression: "console.log('hello', 42, [1,2])", rendered: "hello 42 [\n  1,\n  2\n]" },
    ]
    const program = [
      ...TWINNED_EXPRESSIONS.map((expression) => `console.log((${expression}))`),
      ...GUEST_ONLY_CASES.map(([expression]) => `console.log((${expression}))`),
      "console.log('hello', 42, [1,2])",
      // The LAST expression is the run's result — the value protocol rather than the log protocol,
      // and the one assertion here that does not travel through `console.log`.
      "2 + 3 * 4",
    ].join("\n")

    const r = await evaluate(program)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("14")
    // ⚠️ Load-bearing. A child that died half way through the program would otherwise satisfy every
    // assertion below on the lines it did manage to write. This is the cost of one shared child.
    expect(r.logs.length).toBe(cases.length)
    for (const [index, { expression, rendered }] of cases.entries())
      expect(`${expression} => ${r.logs[index]}`).toBe(`${expression} => ${rendered}`)
  })

  test("a Decimal precision set in one run does not leak into the next (a fresh sandbox per call)", async () => {
    // Two children on purpose: "a fresh sandbox per call" is a per-child property by definition.
    // The FIRST call also proves `Decimal.set` took effect — with default precision (20 significant
    // digits) `toFixed(30)` would pad with zeros. Without that the leak assertion below is vacuous:
    // a `Decimal.set` that silently did nothing would pass it. (Merged 2026-07-28; it used to be a
    // separate test and a separate child, and neither half checked the other's premise.)
    const first = await evaluate("Decimal.set({ precision: 40 }); new Decimal(1).dividedBy(3).toFixed(30)")
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.result).toBe("0.333333333333333333333333333333")

    const second = await evaluate("new Decimal(1).dividedBy(3).toString().length")
    expect(second.ok).toBe(true)
    // default precision is 20 significant digits → "0." + 20 threes = length 22, not 40+
    if (second.ok) expect(second.result).toBe("22")
  })

  test("kills a synchronous infinite loop at the timeout (no hang)", async () => {
    const r = await evaluate("while (true) {}", { timeoutMs: 200 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.timedOut).toBe(true)
      expect(r.error).toContain("timed out")
    }
  })

  test("a PATH-named runtime is only used if it can carry the real child program", async () => {
    // Runtime resolution PROBES before it commits, and the probe has to fail the way the real call
    // would. Observed on Windows: a PATH-resolved `bun` is an npm `.cmd` shim, cross-spawn runs it
    // through `cmd.exe /c`, and cmd.exe cannot carry a MULTI-LINE argument — so a one-line probe
    // certified it and every evaluation then returned "exited with code 0 without a result".
    // Evaluating correctly under BOTH names is the pin; it fails against a shape-blind probe.
    const original = process.env.NOVACLAW_JS_RUNTIME
    try {
      for (const named of ["bun", "node"]) {
        process.env.NOVACLAW_JS_RUNTIME = named
        resetRuntimeCache()
        const r = await evaluate("40 + 2")
        expect(`${named}: ${r.ok ? r.result : r.error}`).toBe(`${named}: 42`)
      }
    } finally {
      if (original === undefined) delete process.env.NOVACLAW_JS_RUNTIME
      else process.env.NOVACLAW_JS_RUNTIME = original
      resetRuntimeCache()
    }
  }, 30_000)

  test("the timeout verdict survives the OTHER runtime", async () => {
    // ⚠️ The realm a vm timeout is thrown from is runtime-specific: bun raises it as a HOST Error,
    // node raises it from inside the terminated context (a GUEST object). An implementation that
    // keys off `instanceof Error` reports node timeouts as ordinary errors — and node is what the
    // packaged desktop sidecar runs, so `bun test` alone would never have shown it. Caught exactly
    // this way while writing this file; this is the pin that keeps it caught.
    // If `node` cannot be started the sandbox falls back to the default runtime and this degrades to
    // a second pass of the case above rather than failing spuriously.
    const original = process.env.NOVACLAW_JS_RUNTIME
    process.env.NOVACLAW_JS_RUNTIME = process.execPath.toLowerCase().includes("node") ? "bun" : "node"
    resetRuntimeCache()
    try {
      const r = await evaluate("while (true) {}", { timeoutMs: 200 })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.timedOut).toBe(true)
    } finally {
      if (original === undefined) delete process.env.NOVACLAW_JS_RUNTIME
      else process.env.NOVACLAW_JS_RUNTIME = original
      resetRuntimeCache()
    }
  }, 20_000)

  test("a snippet that queues unbounded async work still answers immediately", async () => {
    // `vm`'s `timeout` only preempts a SYNCHRONOUS loop; this snippet returns at once and then
    // reschedules itself forever, so in-process it fed the server's own microtask queue with no
    // ceiling. The child writes its result and exits synchronously, so the chain never drains.
    const started = Date.now()
    const r = await evaluate("(function spin(){ Promise.resolve().then(spin) })(); 1", { timeoutMs: 2_000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("1")
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 20_000)

  test("a value whose getter never returns is hard-killed, not a hang", async () => {
    // Rendering the result calls into the snippet's own code, OUTSIDE any vm timeout. In-process
    // that was an unbounded freeze of the server thread (host `JSON.stringify` on a hostile
    // getter). Out of process the parent's hard kill is the ceiling.
    //
    // ⚠️ THIS WAS THE SLOWEST TEST IN `core` — 8.226 s against 14.0 s for the whole file, measured
    // 2026-07-28, i.e. more than every child process in it put together. It was not work: the
    // parent's backstop fires at `timeoutMs + HARD_KILL_GRACE_MS`, and that 8 s grace was a
    // module-private constant with no override, so no `timeoutMs` however small could shorten it.
    // Fixed by making the grace injectable rather than by weakening the assertion — this is the ONLY
    // exercise of the parent's hard-kill path and of the `killedForTimeout` branch that turns a
    // truncated stdout into an honest timeout verdict, so it must keep its real child and its real
    // timer. The override is clamped at `HARD_KILL_GRACE_FLOOR_MS` (see the clamp test below); the
    // value here is the floor, which is still ~35x the observed spawn + decimal.js boot (~81 ms), so
    // the verdict stays honest rather than racing the child's own startup.
    const r = await evaluate("({ get a() { while (true) {} } })", {
      timeoutMs: 200,
      hardKillGraceMs: HARD_KILL_GRACE_FLOOR_MS,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.timedOut).toBe(true)
      expect(r.error).toContain("timed out")
    }
  }, 20_000)

  // The three throwing shapes below each need their OWN child: a throw ends the program, so they
  // cannot share one the way the rendering cases above do. They take three different paths through
  // the child — a guest Error, a guest non-Error routed through the guest formatter, and a compile
  // failure raised in the child's own host realm before the sandbox ever runs.
  test("a thrown error becomes an explicit message, not a crash", async () => {
    const r = await evaluate("throw new Error('boom')")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.timedOut).toBe(false)
      expect(r.error).toContain("boom")
    }
  })

  test("a thrown non-Error value is rendered, not swallowed", async () => {
    const r = await evaluate("throw { code: 42 }")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("42")
  })

  test("a syntax error is reported, not thrown", async () => {
    const r = await evaluate("const = = = ")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.timedOut).toBe(false)
  })

  test("denies host access — no require, process, fetch, Bun or module in the sandbox", async () => {
    // One child, seven lookups. `typeof <undeclared>` cannot throw and cannot mutate the realm, so a
    // pristine realm per reference buys nothing here — it used to cost seven children (0.70 s) for
    // seven global lookups. ⚠️ That reasoning does NOT extend to the constructor walks in the escape
    // suite below, which keep one child each on purpose; see the note there.
    const references = ["require", "process", "fetch", "Bun", "module", "globalThis.require", "globalThis.process"]
    const r = await evaluate(references.map((reference) => `console.log(typeof ${reference})`).join("\n"))
    expect(r.ok).toBe(true)
    // Same reason as above: a child that stopped early must not pass by writing fewer lines.
    expect(r.logs.length).toBe(references.length)
    for (const [index, reference] of references.entries())
      expect(`typeof ${reference} => ${r.logs[index]}`).toBe(`typeof ${reference} => undefined`)
  })

  test("formatValue handles special types", () => {
    expect(formatValue(undefined)).toBe("undefined")
    expect(formatValue(null)).toBe("null")
    expect(formatValue(10n)).toBe("10n")
    expect(formatValue("hi")).toBe("hi")
    expect(formatValue(true)).toBe("true")
    expect(formatValue([1, 2, 3])).toContain("2")
  })
})

// ---------------------------------------------------------------------------------------------
// The escape suite that should have existed.
//
// The sandbox this replaced injected HOST intrinsics (`Object`, `Math`, `JSON`, `Date`, the host
// `Decimal`, a `console` closure …) and then set `require`/`process`/`fetch`/`Bun` to `undefined`.
// The old test only asked `typeof require === "undefined"` and never walked a constructor chain —
// which is exactly why the hole survived. Every injected host object carries the HOST `Function`
// constructor on its prototype chain, and `Function` compiles in ITS OWN realm, so
// `Object.constructor("return globalThis")()` returned the SERVER's global object.
//
// ⚠️ NEGATIVE CONTROL — measured, not asserted. Every probe below was run through the PREVIOUS
// implementation verbatim (`git show HEAD:packages/core/src/tool/js-run.ts`, its `decimal.js` import
// repointed so it could be imported from outside the package) and through this one, side by side, on
// bun 1.3.14. Result: **13 of these 17 probes reached the host realm on the old implementation and
// 0 do here.** The two headline reproductions from the review both hold — the old sandbox answered
// `Object.keys(process.env).length` with **83** and `typeof Bun.spawnSync` with **"function"**.
//
// The four that did NOT escape even before are worth naming so nobody "simplifies" the list: an
// array LITERAL, a function LITERAL and a generator LITERAL always used the guest's own intrinsics,
// and `require` is not a global in the Bun ESM host. They are kept because they are the shapes a
// reader reaches for first, and because they must stay closed under a different host runtime.
//
// ⚠️ AND THESE KEEP ONE CHILD EACH, deliberately — the test-speed pass of 2026-07-28 collapsed the
// pure rendering cases above and left this block alone. A constructor walk is the one shape that can
// plausibly leave a realm changed behind it, so sharing a realm between probes would mean probe N
// runs against something probes 1..N-1 touched. That is a bad trade for 0.9 s on the only suite in
// the tree standing between a model-authored snippet and the server's own process.
// ---------------------------------------------------------------------------------------------
// The hard-kill grace became injectable so the hostile-getter test above could stop costing 8 s of
// wall clock for a `setTimeout`. An override is a loaded gun: below the child's own BOOT_TIMEOUT_MS
// the two deadlines invert, the parent kills a slow-to-init child first, and `runJs` then reports
// "Execution timed out after 0.2s" for a snippet that never ran — ruling 2's false fault
// description. The clamp is what makes that unrepresentable, so it is pinned here rather than
// trusted to the doc comment. Pure: costs no child.
describe("resolveHardKillGraceMs", () => {
  test("defaults to the production grace when no override is given", () => {
    expect(resolveHardKillGraceMs(undefined)).toBe(HARD_KILL_GRACE_MS)
  })

  test("clamps an override up to the floor, so the child always outlives its own boot timeout", () => {
    // NEGATIVE CONTROL: 1 ms is the value a future agent reaches for to make a timeout test instant.
    expect(resolveHardKillGraceMs(1)).toBe(HARD_KILL_GRACE_FLOOR_MS)
    expect(resolveHardKillGraceMs(0)).toBe(HARD_KILL_GRACE_FLOOR_MS)
    expect(resolveHardKillGraceMs(BOOT_TIMEOUT_MS)).toBe(HARD_KILL_GRACE_FLOOR_MS)
  })

  test("honours an override above the floor", () => {
    expect(resolveHardKillGraceMs(HARD_KILL_GRACE_FLOOR_MS + 1_000)).toBe(HARD_KILL_GRACE_FLOOR_MS + 1_000)
  })

  test("the floor outlives the child's boot timeout, which is the whole point of it", () => {
    // If this ever inverts, the parent wins the race and every slow-init failure is misreported.
    expect(HARD_KILL_GRACE_FLOOR_MS).toBeGreaterThan(BOOT_TIMEOUT_MS)
    expect(HARD_KILL_GRACE_MS).toBeGreaterThan(HARD_KILL_GRACE_FLOOR_MS)
  })
})

describe("runJs sandbox escape", () => {
  const HOST_PROBES = [
    `Object.constructor("return typeof process")()`,
    `Object.constructor("return typeof globalThis.process")()`,
    `[].constructor.constructor("return typeof process")()`,
    `Math.max.constructor("return typeof process")()`,
    `JSON.stringify.constructor("return typeof process")()`,
    `Date.constructor("return typeof process")()`,
    `console.log.constructor("return typeof process")()`,
    `Decimal.constructor("return typeof process")()`,
    `new Decimal(1).constructor.constructor("return typeof process")()`,
    `structuredClone.constructor("return typeof process")()`,
    `(function(){}).constructor("return typeof process")()`,
    `Object.getPrototypeOf(Object).constructor("return typeof process")()`,
    `Object.getPrototypeOf(function*(){}).constructor("return typeof process")().next().value`,
  ]

  for (const probe of HOST_PROBES) {
    test(`cannot reach the host realm via ${probe}`, async () => {
      const r = await evaluate(probe)
      // A constructor walk that no longer exists may THROW; what must never happen is a value that
      // proves the host realm was reached.
      if (r.ok) expect(`${probe} => ${r.result}`).toBe(`${probe} => undefined`)
    })
  }

  test("no constructor walk reaches Bun, require, or the server's environment", async () => {
    const attempts = [
      `Object.constructor("return typeof Bun")()`,
      `Math.max.constructor("return typeof require")()`,
      `Object.constructor("return typeof globalThis.fetch")()`,
      `Object.constructor("return typeof process === 'undefined' ? 'undefined' : Object.keys(process.env).length")()`,
    ]
    for (const attempt of attempts) {
      const r = await evaluate(attempt)
      if (r.ok) expect(`${attempt} => ${r.result}`).toBe(`${attempt} => undefined`)
    }
  }, 20_000)

  test("the sandbox's own intrinsics are NOT the host's", async () => {
    // The positive statement behind the fix: a contextified sandbox gets its own realm. If a future
    // change reintroduces an injected host intrinsic, this is the assertion that reads as a lie.
    const r = await evaluate(`Object.constructor === (function(){}).constructor`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("true")
  })

  test("the default child environment carries no secret — belt to the sandbox's braces", () => {
    // `runJs` starts its child from EXACTLY this env (and the tool layers only the offline egress
    // overlay on top), with no inheritance. So even a full escape into the CHILD realm finds no
    // provider key and no peer instance token. If SAFE_ENV_KEYS is ever widened to something
    // secret-bearing, this fails here rather than silently in the sandbox.
    const secret = `NOVACLAW_TEST_SECRET_${Date.now()}`
    process.env[secret] = "should-never-be-visible"
    try {
      const env = AgentJail.unattendedChildEnv(process.env)
      expect(Object.keys(env)).not.toContain(secret)
      expect(Object.values(env)).not.toContain("should-never-be-visible")
      expect(Object.keys(env).length).toBeLessThan(Object.keys(process.env).length)
    } finally {
      delete process.env[secret]
    }
  })
})

// ---------------------------------------------------------------------------------------------
// ─── the spawn ledger ─────────────────────────────────────────────────────────────────────────
//
// Ruling 1's mechanical check for this file: *every invariant whose violation compiles green ships
// with a check, or the invariant does not exist.* The invariant here is **no child process for a
// pure assertion** — and its violation is silent, which is how this file grew to 63 children.
//
// It is a RATCHET, asserted exactly, so it fails in both directions: a new child for a pure
// assertion pushes the count over, and removing one without lowering the ledger pushes it under and
// says so. A direct call to the imported evaluator would slip past the counter entirely, so the
// source check below forbids one — the counter and the source check are load-bearing together.
//
// ⚠️ This counts SANDBOX children only, not the runtime PROBE children `resolveRuntime` starts.
// Probe count is environment-dependent (it walks candidates until one answers, so a box without
// `node` on PATH spends more than one), and a ledger that changes with the host is not a ratchet.
// ---------------------------------------------------------------------------------------------
describe("the spawn ledger", () => {
  /** Every child this file may start, and what it buys. Lower it when you remove one. */
  const SPAWN_LEDGER: ReadonlyArray<readonly [children: number, why: string]> = [
    [1, "one child renders every pure value case — was 21 (six tests plus a 15-expression loop)"],
    [2, "a Decimal precision must not leak, which is a per-child property by definition"],
    [1, "a synchronous infinite loop is killed at the vm timeout"],
    [2, "`bun` and `node` from PATH must each carry the multi-line child program"],
    [1, "the timeout verdict must survive the OTHER runtime — the realm it is thrown from differs"],
    [1, "a runaway microtask chain must not outlive the call"],
    [1, "a hostile getter must be hard-killed by the parent — was the 8 s test until the grace became injectable"],
    [3, "a throw ends its program, so each thrown/syntax shape needs its own child"],
    [1, "host globals are absent across the realm boundary — was 7, `typeof` cannot mutate a realm"],
    [13, "ONE CHILD PER ESCAPE PROBE, on purpose — a constructor walk gets a pristine realm"],
    [4, "the Bun/require/env constructor walks, same reason"],
    [1, "the sandbox's intrinsics are its own"],
    [1, "the negative control below, which must spend a child to prove the counter moves"],
  ]
  const SPAWN_BUDGET = SPAWN_LEDGER.reduce((sum, [children]) => sum + children, 0)

  /** The comment stripper `src/jh/imports.test.ts` uses — `//` must not eat the `//` in a URL. */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

  /** Call sites of the imported evaluator. A loop is invisible to this, which is why the RUNTIME
   *  counter is the ratchet and this check only guarantees the counter cannot be bypassed. */
  const callSites = (source: string): number => (source.match(/\brunJs\s*\(/g) ?? []).length

  const SELF = stripComments(fs.readFileSync(path.join(import.meta.dir, "js-run.test.ts"), "utf8"))

  /** The call spelling, split so the fixtures below are not themselves call sites this check counts. */
  const CALL = `run${"Js"}(`

  test("every sandbox child goes through the counting seam", () => {
    // Exactly one call site may exist in this file: the one inside `evaluate`. A test that calls the
    // evaluator directly would be invisible to the ledger, and the ledger is the whole guard.
    expect(callSites(SELF), "call `evaluate(...)`, not the imported evaluator, so the ledger sees it").toBe(1)
  })

  test("the counter actually moves — it is not a frozen zero the ledger was fitted to", async () => {
    // Negative control for the counter. `toBe(SPAWN_BUDGET)` on its own cannot tell a working
    // counter from a dead one whose ledger was edited to match whatever it read. So: take a
    // reading, spend one child, take another. This child is the last entry in the ledger above.
    const before = sandboxChildren
    const r = await evaluate("1 + 1")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("2")
    expect(sandboxChildren).toBe(before + 1)
  })

  test("the source check reports a direct call, and does not fire on prose about one", () => {
    // Negative control for the source check: the assertion above is `=== 1`, which alone cannot show
    // that a violation is reachable. These are the two shapes that would quietly re-add a child.
    expect(callSites(`test("x", async () => { const r = await ${CALL}"2 + 2") })`)).toBe(1)
    expect(callSites(`const evaluate = (c) => ${CALL}c)\nconst r = await ${CALL}"2 + 2")`)).toBe(2)
    // …and a comment that merely names it is code-clean, because comments are stripped first.
    expect(callSites(stripComments(`// never call ${CALL}) from a test\nconst x = 1`))).toBe(0)
    // The counting seam's own spelling must be what the check sees, not a lookalike.
    expect(callSites(`const runJsLater = 1\nevaluate("2 + 2")`)).toBe(0)
  })

  test("this file starts exactly the children its ledger accounts for", () => {
    // ⚠️ Counts what the tests ABOVE did, so it needs the whole file — a `--test-name-pattern` that
    // reaches this test but not the others will read low, correctly.
    expect(sandboxChildren, "the spawn ledger is stale — reconcile it with what the tests now do").toBe(SPAWN_BUDGET)
  })
})
