import spawn from "cross-spawn"
import type { ChildProcess } from "node:child_process"
// We need decimal.js as SOURCE TEXT, not as a module: it is evaluated INSIDE the sandbox realm so
// the snippet's `Decimal` is a guest-realm object. Importing it normally and injecting the resulting
// host class is exactly the hole this module was rewritten to close — see the header below.
// A text import (rather than reading the file at runtime) is what makes this work in the PRODUCT and
// not just from source: nothing resolves `node_modules` next to the desktop sidecar, but the text is
// inlined at bundle time. Verified end to end: the `bun` runtime, `Bun.build({target:"node"})` (how
// the sidecar and the CLI binary are built), and the resulting bundle run under node 24.
// @ts-ignore — the subpath has no type declaration; `with { type: "text" }` yields a string.
import decimalSource from "decimal.js/decimal.js" with { type: "text" }
import { AgentJail } from "../agent-jail"

// The engine behind the `js` tool: evaluate a model-authored snippet OUT OF PROCESS, inside a
// fresh, bare `node:vm` realm.
//
// ⚠️ WHY THIS IS NOT AN IN-PROCESS `vm.runInNewContext(code, sandbox)` ANY MORE.
// The previous version built a sandbox literal that injected HOST intrinsics (`Object`, `Math`,
// `JSON`, `Date`, a `console` closure, the host `Decimal` …) and then pinned
// `require`/`process`/`fetch`/`Bun` to `undefined` as "belt and suspenders". The pins were
// decorative: every injected host object carries the HOST `Function` constructor on its prototype
// chain, so `Object.constructor("return globalThis")()` compiled and ran in the HOST realm.
// Reproduced 2026-07-27 under Bun: `Bun.spawnSync` reachable, and an 83-key `process.env` holding
// provider API keys and peer instance tokens. Re-verified while writing this module, on bun 1.3.14
// AND node 24 — `Object.constructor(...)` and `Math.max.constructor(...)` both reach host `process`
// the moment a host object is injected.
//
// Two structural changes close it, and the escape suite in `js-run.test.ts` is the mechanical check
// (it is negative-controlled: it fails against the old injected-sandbox shape):
//
//  1. **A BARE realm — inject NOTHING.** A contextified sandbox gets its OWN intrinsics from V8, so
//     `Object`/`Math`/`JSON`/`Array`/`BigInt`/`Promise`/… already exist in the guest and are NOT the
//     host's. Measured on bun 1.3.14 and node 24: for a bare context every constructor-walk escape
//     returns `undefined` for `process`. The only things a bare context lacks that this tool
//     promised are `console` and `structuredClone`; both are re-implemented in GUEST source below,
//     and `Decimal` is obtained by evaluating decimal.js's SOURCE inside the guest. Nothing that
//     crosses into the sandbox is a host object — only strings and numbers go in, only strings come
//     out (the guest formats its own values and its own logs).
//  2. **A CHILD PROCESS.** Even a sandbox escape now lands in a disposable process that (a) was
//     started from `AgentJail.unattendedChildEnv` — the same curated, secret-free environment
//     `tool/bash.ts` gives a confined command, with `extendEnv` off — so no provider key or peer
//     token is present to steal, and (b) is hard-killed by the parent. That kill is what bounds the
//     paths `vm`'s own `timeout` never bounded: `timeout` preempts a synchronous loop, but a
//     runaway microtask chain outlives the call. It also ends the synchronous event-loop stall —
//     a 5 s runaway used to freeze the whole server thread.
//
// Sandbox contract (unchanged for the model): standard JS + `BigInt` + `Decimal` (arbitrary
// precision) + `Date`/`Math`/`JSON`. No filesystem, network, `require`, or `process`. An error or
// timeout comes back as an explicit message (`ok:false`), never a thrown crash or a silent halt.

export const JS_TIMEOUT_MS = 5000
const MAX_OUTPUT_CHARS = 10_000
const MAX_LOG_LINES = 1_000
/** How long the sandbox bootstrap (decimal.js — measured ≈ 11 ms — plus the shims) may take before
 *  we call it broken. Deliberately far BELOW the parent's grace below: if init is what is slow, the
 *  child must say so itself rather than be killed and reported as the snippet timing out. Ruling 2 —
 *  a fault is never described falsely. */
export const BOOT_TIMEOUT_MS = 3_000
/** Headroom over `timeoutMs` before the PARENT kills the child: covers spawn + bootstrap + the
 *  child's own honest failure messages, and is the backstop for anything `vm`'s timeout cannot
 *  preempt (a runaway microtask chain, a getter that never returns while the result is rendered). */
export const HARD_KILL_GRACE_MS = 8_000
/** The floor any `hardKillGraceMs` override is clamped to. It must exceed `BOOT_TIMEOUT_MS`, because
 *  below it the ORDERING of the two deadlines inverts: the parent would kill a slow-to-init child
 *  before the child could report its own boot failure, and `runJs` would then answer "Execution timed
 *  out after <timeoutMs>s" for a snippet that never ran. Ruling 2 — a fault is never described
 *  falsely. Pinned with a negative control in `js-run.test.ts`; do not lower it to buy test seconds. */
export const HARD_KILL_GRACE_FLOOR_MS = BOOT_TIMEOUT_MS + 500

/** Resolve the parent's hard-kill grace, honouring an override but never below the honest-fault
 *  floor. Pure and exported so the clamp is testable rather than asserted in a comment. */
export function resolveHardKillGraceMs(requested?: number): number {
  if (requested === undefined) return HARD_KILL_GRACE_MS
  return Math.max(requested, HARD_KILL_GRACE_FLOOR_MS)
}
/** Refuse to buffer a rogue child forever. The guest already caps itself far below this. */
const MAX_CHILD_OUTPUT_BYTES = 32 * 1024 * 1024

const DECIMAL_SOURCE: string = decimalSource as unknown as string

export type JsRun =
  | { readonly ok: true; readonly result: string; readonly logs: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly timedOut: boolean; readonly logs: readonly string[] }

export interface JsRunOptions {
  readonly timeoutMs?: number
  /**
   * The child's environment, composed by the caller through the SAME helpers `tool/bash.ts` uses
   * (`AgentJail.unattendedChildEnv` + `Offline.egressEnv`). It REPLACES the process environment —
   * the child never inherits. Defaults to `AgentJail.unattendedChildEnv(process.env)` so a direct
   * caller (a test, a future consumer) cannot accidentally hand the sandbox the server's secrets.
   */
  readonly env?: Record<string, string>
  /** Abort the run and kill the child (wire this to fiber interruption). */
  readonly signal?: AbortSignal
  /**
   * Override the parent's hard-kill headroom over `timeoutMs`. Exists because the default 8 s is the
   * dominant cost of any test that deliberately provokes the backstop — one such test measured 8.2 s
   * of an 11.8 s file (2026-07-28), invariant across runs because it is a `setTimeout`, not work.
   * Clamped to `HARD_KILL_GRACE_FLOOR_MS`: a grace below the child's own `BOOT_TIMEOUT_MS` would make
   * a slow init report as the snippet timing out. Production callers pass nothing.
   */
  readonly hardKillGraceMs?: number
}

/** Render any runtime value for display — BigInt (`10n`), Decimal, objects, undefined all included.
 *  Host-realm twin of the guest formatter in `GUEST_BOOTSTRAP`; `js-run.test.ts` pins them equal. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "symbol") return value.toString()
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`
  // Realm-agnostic: a sandbox Decimal is NOT an instance of any host class, by construction.
  if (isDecimalLike(value)) return String(value)
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v), 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const isDecimalLike = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { toFixed?: unknown; toSignificantDigits?: unknown }
  return typeof candidate.toFixed === "function" && typeof candidate.toSignificantDigits === "function"
}

const clamp = (text: string) =>
  text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}… [truncated, ${text.length} chars]` : text

/**
 * Everything the guest realm gets, as GUEST source. Evaluated after decimal.js, it returns the
 * private API the child uses to render results and drain logs — the returned object is held only by
 * the child (host side), never left on the guest global, so a snippet cannot reach or replace it.
 *
 * Intrinsics are captured into locals first: a snippet may reassign `JSON`/`Map`/… and that must
 * break only the snippet, not the result protocol.
 *
 * ⚠️ Nothing in here may close over a host value. Only string/number literals cross the boundary.
 */
const GUEST_BOOTSTRAP = `(function () {
  "use strict";
  var _JSON = JSON, _Object = Object, _Array = Array, _Date = Date, _RegExp = RegExp;
  var _Map = Map, _Set = Set, _String = String, _Error = Error;
  var MAX_LOG_LINES = ${MAX_LOG_LINES};
  var MAX_OUTPUT_CHARS = ${MAX_OUTPUT_CHARS};
  var D = typeof Decimal === "function" ? Decimal : null;
  var logs = [];

  function clamp(text) {
    return text.length > MAX_OUTPUT_CHARS
      ? text.slice(0, MAX_OUTPUT_CHARS) + "… [truncated, " + text.length + " chars]"
      : text;
  }

  function formatValue(value) {
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    var kind = typeof value;
    if (kind === "bigint") return value + "n";
    if (kind === "string") return value;
    if (kind === "number" || kind === "boolean") return _String(value);
    if (kind === "symbol") return value.toString();
    if (kind === "function") return "[Function: " + (value.name || "anonymous") + "]";
    if (D !== null && value instanceof D) return value.toString();
    if (value instanceof _Error) return value.name + ": " + value.message;
    try {
      var json = _JSON.stringify(value, function (key, entry) {
        return typeof entry === "bigint" ? entry + "n" : entry;
      }, 2);
      return json === undefined ? _String(value) : json;
    } catch (error) {
      return _String(value);
    }
  }

  function formatThrown(thrown) {
    if (thrown instanceof _Error) {
      var name = "Error";
      var message = "";
      try { name = _String(thrown.name); } catch (error) {}
      try { message = _String(thrown.message); } catch (error) {}
      return name + ": " + message;
    }
    try { return formatValue(thrown); } catch (error) { return "the thrown value could not be rendered"; }
  }

  function record() {
    if (logs.length >= MAX_LOG_LINES) return;
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(formatValue(arguments[i]));
    logs.push(clamp(parts.join(" ")));
  }
  // Replaces the context's built-in console, which would otherwise write to the CHILD's stdout and
  // corrupt the result protocol.
  globalThis.console = { log: record, info: record, warn: record, error: record, debug: record };

  // A bare realm has no structuredClone (it is a host global, not an ECMAScript intrinsic), and the
  // host one was a leak vector. Guest-realm replacement covering the structured-clone shapes a
  // calculator meets; cycles preserved, functions and symbols rejected as the real one rejects them.
  function cloneValue(value, seen) {
    if (value === null || typeof value !== "object") {
      if (typeof value === "function") throw new _Error("structuredClone: a function could not be cloned");
      if (typeof value === "symbol") throw new _Error("structuredClone: a symbol could not be cloned");
      return value;
    }
    if (seen.has(value)) return seen.get(value);
    var out;
    if (value instanceof _Date) { out = new _Date(value.getTime()); seen.set(value, out); return out; }
    if (value instanceof _RegExp) { out = new _RegExp(value.source, value.flags); seen.set(value, out); return out; }
    if (_Array.isArray(value)) {
      out = []; seen.set(value, out);
      for (var i = 0; i < value.length; i++) out[i] = cloneValue(value[i], seen);
      return out;
    }
    if (value instanceof _Map) {
      out = new _Map(); seen.set(value, out);
      value.forEach(function (entry, key) { out.set(cloneValue(key, seen), cloneValue(entry, seen)); });
      return out;
    }
    if (value instanceof _Set) {
      out = new _Set(); seen.set(value, out);
      value.forEach(function (entry) { out.add(cloneValue(entry, seen)); });
      return out;
    }
    out = {}; seen.set(value, out);
    var keys = _Object.keys(value);
    for (var k = 0; k < keys.length; k++) out[keys[k]] = cloneValue(value[keys[k]], seen);
    return out;
  }
  globalThis.structuredClone = function (value) { return cloneValue(value, new _Map()); };

  return {
    format: function (value) { return clamp(formatValue(value)); },
    formatThrown: function (thrown) { return clamp(formatThrown(thrown)); },
    logsJson: function () { return _JSON.stringify(logs); },
  };
})()`

/**
 * The child program, passed as `-e`. Host-realm code: it owns the vm boundary and the wire protocol
 * and NEVER hands a host object to the guest — `runInContext` takes strings, results come back as
 * strings the guest itself produced.
 *
 * It writes ONE JSON object to stdout and exits immediately, synchronously. The immediate
 * `process.exit(0)` is load-bearing: it is what prevents a runaway microtask chain queued by the
 * snippet from ever draining.
 */
const CHILD_PROGRAM = `"use strict";
var vm = require("node:vm");
var fs = require("node:fs");
function emit(payload) {
  try {
    var bytes = Buffer.from(JSON.stringify(payload), "utf8");
    var offset = 0;
    while (offset < bytes.length) {
      try { offset += fs.writeSync(1, bytes, offset, bytes.length - offset); }
      catch (error) { if (error && (error.code === "EAGAIN" || error.code === "EINTR")) continue; throw error; }
    }
  } catch (error) {}
}
function fail(message) { emit({ ok: false, timedOut: false, error: message, logs: [] }); process.exit(0); }
var input;
try { input = JSON.parse(fs.readFileSync(0, "utf8")); }
catch (error) { fail("js sandbox: the evaluation request could not be read"); }
var context = vm.createContext({});
var api;
try {
  vm.runInContext(input.decimal, context, { timeout: input.bootMs, displayErrors: false });
  api = vm.runInContext(input.bootstrap, context, { timeout: input.bootMs, displayErrors: false });
} catch (error) {
  fail("js sandbox: failed to initialise (" + (error && error.message ? error.message : error) + ")");
}
var value;
var thrown;
var threw = false;
try { value = vm.runInContext(input.code, context, { timeout: input.timeoutMs, displayErrors: false }); }
catch (error) { threw = true; thrown = error; }
var logs = [];
try { logs = JSON.parse(api.logsJson()); } catch (error) {}
if (!threw) {
  var rendered;
  try { rendered = String(api.format(value)); } catch (error) { rendered = "the result could not be rendered"; }
  emit({ ok: true, result: rendered, logs: logs });
} else {
  // ⚠️ The realm a vm timeout is thrown FROM differs by runtime, so it must never be the signal.
  // Measured: on bun 1.3.14 the timeout arrives as a HOST Error; on node 24 the watchdog raises it
  // from inside the terminated context, so it is a GUEST object and \`instanceof Error\` is false.
  // Keying off the realm meant timeouts were reported as ordinary errors under node — i.e. only in
  // the packaged sidecar. The runtime-stamped shape is the signal instead.
  var rawMessage = "";
  var rawCode = "";
  try { rawMessage = String(thrown && thrown.message); } catch (error) {}
  try { rawCode = String(thrown && thrown.code); } catch (error) {}
  var timedOut = rawCode === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /Script execution timed out after \\d+ *ms/.test(rawMessage);
  var message;
  if (thrown instanceof Error) message = thrown.name + ": " + thrown.message;
  else {
    try { message = String(api.formatThrown(thrown)); } catch (error) { message = rawMessage || "an error was thrown"; }
  }
  emit({ ok: false, timedOut: timedOut, error: message, logs: logs });
}
process.exit(0);
`

const RUNTIME_PROBE_TOKEN = "novaclaw-js-runtime-ok"
// ⚠️ The probe must have the same SHAPE as the real call, or it certifies runtimes that then fail.
// Measured on Windows: a PATH-resolved `bun` is an npm `.cmd` shim, which cross-spawn runs through
// `cmd.exe /c` — and cmd.exe cannot carry a MULTI-LINE argument. A one-line probe passed, the
// multi-line child program was truncated, and every evaluation came back "exited with code 0
// without a result". So the probe is multi-line, reads stdin to EOF, writes to stdout and exits
// immediately: every property the child program depends on.
const RUNTIME_PROBE_PROGRAM = [
  `var fs = require("node:fs");`,
  `var input = fs.readFileSync(0, "utf8");`,
  `fs.writeSync(1, input === ${JSON.stringify(RUNTIME_PROBE_TOKEN)} ? ${JSON.stringify(RUNTIME_PROBE_TOKEN)} : "stdin-lost");`,
  `process.exit(0);`,
].join("\n")

/**
 * `process.execPath` is NOT always a JS runtime that understands `-e`, and getting this wrong would
 * kill the tool only in the packaged product (the class of bug AGENTS.md's "smoke the artifact"
 * pitfall is about):
 *  - the desktop sidecar is an Electron `utilityProcess.fork` (`desktop/src/main/server.ts:87`), so
 *    `execPath` is the NovaClaw binary — `ELECTRON_RUN_AS_NODE=1` makes it behave as plain Node;
 *  - the standalone CLI is a `bun build --compile` single-file executable, which runs its embedded
 *    entrypoint instead of reading `-e` — `BUN_BE_BUN=1` is Bun's documented opt-out for that.
 * Both variables are inert when `execPath` really is `bun`/`node`, so they are always set. Rather
 * than trust that reasoning, the resolved runtime is PROVED once per process with a probe run, and
 * `bun`/`node` from PATH are the fallbacks. `NOVACLAW_JS_RUNTIME` overrides everything (an agent can
 * repair a host we did not anticipate without a rebuild — AGENTS.md §self-healing).
 */
const RUNTIME_ENV_OVERLAY: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1", BUN_BE_BUN: "1" }

let runtimeResolution: Promise<string | undefined> | undefined

const probeRuntime = (command: string, env: Record<string, string>): Promise<boolean> =>
  new Promise((resolve) => {
    let spawned: ChildProcess | undefined
    try {
      spawned = spawn(command, ["-e", RUNTIME_PROBE_PROGRAM], {
        env: { ...env, ...RUNTIME_ENV_OVERLAY },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      })
    } catch {
      spawned = undefined
    }
    if (spawned === undefined) return resolve(false)
    const child = spawned
    let out = ""
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
      finish(false)
    }, 15_000)
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += String(chunk)
    })
    child.on("error", () => finish(false))
    child.on("close", () => finish(out.includes(RUNTIME_PROBE_TOKEN)))
    child.stdin?.on("error", () => {})
    try {
      child.stdin?.end(RUNTIME_PROBE_TOKEN)
    } catch {
      finish(false)
    }
  })

const resolveRuntime = (env: Record<string, string>): Promise<string | undefined> => {
  runtimeResolution ??= (async () => {
    const candidates = [process.env.NOVACLAW_JS_RUNTIME, process.execPath, "bun", "node"].filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    )
    for (const candidate of candidates) if (await probeRuntime(candidate, env)) return candidate
    return undefined
  })()
  return runtimeResolution
}

/** Test seam: drop the per-process runtime resolution. */
export function resetRuntimeCache(): void {
  runtimeResolution = undefined
}

const failed = (error: string, timedOut = false): JsRun => ({ ok: false, error, timedOut, logs: [] })

/**
 * Evaluate `code` in a fresh out-of-process sandbox. Never rejects and never throws — a failure is
 * an observation the model can act on (`ok:false`), exactly as before.
 */
export async function runJs(code: string, opts?: JsRunOptions): Promise<JsRun> {
  const timeoutMs = opts?.timeoutMs ?? JS_TIMEOUT_MS
  // The floor is the confined-command environment `tool/bash.ts` composes: only the functional,
  // non-secret keys. A caller may add to it (the tool layers the offline egress overlay on top); it
  // can never be the server's own environment, because the child is spawned with this env INSTEAD
  // of inheriting (node replaces `process.env` wholesale when `env` is given).
  const env = opts?.env ?? AgentJail.unattendedChildEnv(process.env)
  const runtime = await resolveRuntime(env)
  if (runtime === undefined)
    return failed(
      "js sandbox: no JavaScript runtime could be started to evaluate the snippet. Set NOVACLAW_JS_RUNTIME to a bun or node executable.",
    )
  if (opts?.signal?.aborted) return failed("js sandbox: evaluation was cancelled")

  return new Promise<JsRun>((resolve) => {
    let spawned: ChildProcess | undefined
    let spawnError: unknown
    try {
      spawned = spawn(runtime, ["-e", CHILD_PROGRAM], {
        env: { ...env, ...RUNTIME_ENV_OVERLAY },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      spawnError = error
    }
    if (spawned === undefined)
      return resolve(
        failed(
          `js sandbox: could not start ${runtime} (${spawnError instanceof Error ? spawnError.message : String(spawnError)})`,
        ),
      )
    const child = spawned

    let stdout = ""
    let stderr = ""
    let settled = false
    let killedForTimeout = false

    const kill = () => {
      try {
        child.kill("SIGKILL")
      } catch {}
    }
    const settle = (run: JsRun) => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      opts?.signal?.removeEventListener("abort", onAbort)
      resolve(run)
    }
    const onAbort = () => {
      kill()
      settle(failed("js sandbox: evaluation was cancelled"))
    }
    // The backstop `vm`'s own timeout cannot be: it preempts a synchronous loop, but a runaway
    // microtask chain (a self-rescheduling Promise) outlives the call and would otherwise pin the
    // child forever. The grace covers spawn + sandbox bootstrap.
    const hardTimer = setTimeout(
      () => {
        killedForTimeout = true
        kill()
      },
      timeoutMs + resolveHardKillGraceMs(opts?.hardKillGraceMs),
    )

    opts?.signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk)
      if (stdout.length > MAX_CHILD_OUTPUT_BYTES) kill()
    })
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4096) stderr += String(chunk)
    })
    child.stdin?.on("error", () => {}) // the child may exit before we finish writing; not our error
    child.on("error", (error) =>
      settle(
        failed(
          `js sandbox: ${runtime} could not be started (${error instanceof Error ? error.message : String(error)})`,
        ),
      ),
    )
    child.on("close", (exitCode) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch {
        // A hard kill can also land mid-write, so the timeout reading wins over "no result".
        if (killedForTimeout) return settle(failed(`Execution timed out after ${timeoutMs / 1000}s`, true))
        const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400)
        return settle(
          failed(
            `js sandbox: the evaluation process exited with code ${exitCode} without a result${detail ? ` (${detail})` : ""}`,
          ),
        )
      }
      const result = parsed as {
        ok?: unknown
        result?: unknown
        error?: unknown
        timedOut?: unknown
        logs?: unknown
      }
      const logs = Array.isArray(result.logs) ? result.logs.map((line) => clamp(String(line))) : []
      if (result.ok === true) return settle({ ok: true, result: clamp(String(result.result ?? "")), logs })
      const timedOut = result.timedOut === true
      return settle({
        ok: false,
        timedOut,
        // The child never formats the timeout sentence — one place owns that wording.
        error: timedOut
          ? `Execution timed out after ${timeoutMs / 1000}s`
          : clamp(String(result.error ?? "unknown error")),
        logs,
      })
    })

    try {
      child.stdin?.end(
        JSON.stringify({
          code,
          timeoutMs,
          bootMs: BOOT_TIMEOUT_MS,
          decimal: DECIMAL_SOURCE,
          bootstrap: GUEST_BOOTSTRAP,
        }),
      )
    } catch {
      kill()
      settle(failed("js sandbox: the evaluation request could not be sent to the sandbox"))
    }
  })
}
