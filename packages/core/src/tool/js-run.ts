import vm from "node:vm"
import Decimal from "decimal.js"

// The pure engine behind the `js` tool: evaluate a snippet in an isolated `node:vm` context.
//
// Why node:vm (verified on bun 1.3.14): a fresh context exposes ONLY the globals we inject
// (`typeof require`/`process` === "undefined"), and its `timeout` option *interrupts a
// synchronous infinite loop* — V8 preempts the running script — so a runaway is bounded, never a
// hang, without a worker/subprocess. `runInNewContext` also returns the completion value (the last
// expression), which is exactly the "what did this evaluate to" the model wants.
//
// Sandbox: standard JS + `BigInt` + `Decimal` (arbitrary precision) + `Date`/`Math`/`JSON`. No
// filesystem, network, `require`, or `process`. An error or timeout comes back as an explicit
// message (`ok:false`), never a thrown crash or silent halt — errors-as-observations for the model.
//
// v1 limitations (documented follow-ups): the run is synchronous, so a genuine 5s runaway blocks the
// server thread for up to the timeout (fine for a calculator; offload to a Worker later). No per-run
// heap cap (node:vm can't bound a context's memory; the timeout bounds runaway allocation).

export const JS_TIMEOUT_MS = 5000
const MAX_OUTPUT_CHARS = 10_000
const MAX_LOG_LINES = 1_000

export type JsRun =
  | { readonly ok: true; readonly result: string; readonly logs: readonly string[] }
  | { readonly ok: false; readonly error: string; readonly timedOut: boolean; readonly logs: readonly string[] }

/** Render any runtime value for display — BigInt (`10n`), Decimal, objects, undefined all included. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "symbol") return value.toString()
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`
  if (value instanceof Decimal) return value.toString()
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v), 2) ?? String(value)
  } catch {
    return String(value)
  }
}

const clamp = (text: string) =>
  text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}… [truncated, ${text.length} chars]` : text

export function runJs(code: string, opts?: { readonly timeoutMs?: number }): JsRun {
  const timeoutMs = opts?.timeoutMs ?? JS_TIMEOUT_MS
  // Decimal's config (precision/rounding) is process-global; a snippet may `Decimal.set(...)`, so reset
  // to defaults before each run — every call starts identical regardless of a prior one. Safe because
  // runJs is synchronous (never two concurrently) and this tool is decimal.js's only consumer in core.
  Decimal.set({ defaults: true })
  const logs: string[] = []
  const record = (...args: unknown[]) => {
    if (logs.length < MAX_LOG_LINES) logs.push(args.map(formatValue).join(" "))
  }

  // A FRESH sandbox per call (contextifying mutates it) → no state leaks between runs. The context
  // exposes only these; anything host-reaching (require/process/fetch/Bun/module) is pinned undefined
  // as belt-and-suspenders over vm's natural isolation, and stays testable.
  const sandbox: Record<string, unknown> = {
    Decimal,
    BigInt,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Date,
    RegExp,
    Map,
    Set,
    Symbol,
    Promise,
    Infinity,
    NaN,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    structuredClone,
    console: { log: record, info: record, warn: record, error: record, debug: record },
    require: undefined,
    process: undefined,
    fetch: undefined,
    Bun: undefined,
    module: undefined,
    exports: undefined,
    global: undefined,
  }

  try {
    const value = vm.runInNewContext(code, sandbox, { timeout: timeoutMs, displayErrors: false })
    return { ok: true, result: clamp(formatValue(value)), logs: logs.map(clamp) }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const timedOut = /timed out/i.test(message)
    return {
      ok: false,
      timedOut,
      error: timedOut ? `Execution timed out after ${timeoutMs / 1000}s` : message,
      logs: logs.map(clamp),
    }
  }
}
