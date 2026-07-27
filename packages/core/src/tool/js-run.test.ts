import { describe, expect, test } from "bun:test"
import { AgentJail } from "../agent-jail"
import { runJs, formatValue, resetRuntimeCache } from "./js-run"

describe("runJs", () => {
  test("returns the last-expression value (exact arithmetic)", async () => {
    const r = await runJs("2 + 3 * 4")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("14")
  })

  test("BigInt exact big-integer math", async () => {
    const r = await runJs("2n ** 64n")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("18446744073709551616n")
  })

  test("Decimal arbitrary precision (pre-imported, configurable per run)", async () => {
    const r = await runJs("Decimal.set({ precision: 40 }); new Decimal(1).dividedBy(3).toFixed(30)")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("0.333333333333333333333333333333")
  })

  test("Decimal config does not leak between runs (a fresh sandbox per call)", async () => {
    await runJs("Decimal.set({ precision: 40 }); 1")
    const r = await runJs("new Decimal(1).dividedBy(3).toString().length")
    expect(r.ok).toBe(true)
    // default precision is 20 significant digits → "0." + 20 threes = length 22, not 40+
    if (r.ok) expect(r.result).toBe("22")
  })

  test("a returned Decimal renders as its value, not as an object", async () => {
    const r = await runJs("new Decimal(1).dividedBy(8)")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("0.125")
  })

  test("captures console.log, keeps the final value", async () => {
    const r = await runJs("console.log('hello', 42, [1,2]); 7")
    expect(r.ok).toBe(true)
    expect(r.logs).toEqual(["hello 42 [\n  1,\n  2\n]"])
    if (r.ok) expect(r.result).toBe("7")
  })

  test("Date is available (solves 'what is today')", async () => {
    const r = await runJs("new Date(0).toISOString()")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("1970-01-01T00:00:00.000Z")
  })

  test("structuredClone is available and is a real deep copy", async () => {
    const r = await runJs("const a = { n: [1, 2] }; const b = structuredClone(a); b.n.push(3); a.n.length")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("2")
  })

  test("kills a synchronous infinite loop at the timeout (no hang)", async () => {
    const r = await runJs("while (true) {}", { timeoutMs: 200 })
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
        const r = await runJs("40 + 2")
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
      const r = await runJs("while (true) {}", { timeoutMs: 200 })
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
    const r = await runJs("(function spin(){ Promise.resolve().then(spin) })(); 1", { timeoutMs: 2_000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe("1")
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 20_000)

  test("a value whose getter never returns is hard-killed, not a hang", async () => {
    // Rendering the result calls into the snippet's own code, OUTSIDE any vm timeout. In-process
    // that was an unbounded freeze of the server thread (host `JSON.stringify` on a hostile
    // getter). Out of process the parent's hard kill is the ceiling.
    const r = await runJs("({ get a() { while (true) {} } })", { timeoutMs: 200 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.timedOut).toBe(true)
      expect(r.error).toContain("timed out")
    }
  }, 20_000)

  test("a thrown error becomes an explicit message, not a crash", async () => {
    const r = await runJs("throw new Error('boom')")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.timedOut).toBe(false)
      expect(r.error).toContain("boom")
    }
  })

  test("a thrown non-Error value is rendered, not swallowed", async () => {
    const r = await runJs("throw { code: 42 }")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("42")
  })

  test("a syntax error is reported, not thrown", async () => {
    const r = await runJs("const = = = ")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.timedOut).toBe(false)
  })

  test("sandbox denies host access", async () => {
    for (const ref of ["require", "process", "fetch", "Bun", "module", "globalThis.require", "globalThis.process"]) {
      const r = await runJs(`typeof ${ref}`)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.result).toBe("undefined")
    }
  })

  test("formatValue handles special types", () => {
    expect(formatValue(undefined)).toBe("undefined")
    expect(formatValue(null)).toBe("null")
    expect(formatValue(10n)).toBe("10n")
    expect(formatValue("hi")).toBe("hi")
    expect(formatValue(true)).toBe("true")
    expect(formatValue([1, 2, 3])).toContain("2")
  })

  // Ruling 1: the guest formatter is a source-string twin of the exported host `formatValue`, and a
  // silent divergence between them would compile green. This is the check that bites.
  test("the guest formatter and the host formatValue agree", async () => {
    const expressions = [
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
    for (const expression of expressions) {
      const r = await runJs(`(${expression})`)
      expect(r.ok).toBe(true)
      const hostValue = new Function(`return (${expression})`)()
      if (r.ok) expect(`${expression} => ${r.result}`).toBe(`${expression} => ${formatValue(hostValue)}`)
    }
  }, 30_000)
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
// ---------------------------------------------------------------------------------------------
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
      const r = await runJs(probe)
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
      const r = await runJs(attempt)
      if (r.ok) expect(`${attempt} => ${r.result}`).toBe(`${attempt} => undefined`)
    }
  }, 20_000)

  test("the sandbox's own intrinsics are NOT the host's", async () => {
    // The positive statement behind the fix: a contextified sandbox gets its own realm. If a future
    // change reintroduces an injected host intrinsic, this is the assertion that reads as a lie.
    const r = await runJs(`Object.constructor === (function(){}).constructor`)
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
