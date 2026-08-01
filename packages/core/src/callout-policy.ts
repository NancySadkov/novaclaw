export * as CalloutPolicy from "./callout-policy"

/** A callout is work NovaClaw delegates across a boundary it does not control: another process,
 * host, model pass, verifier, or maintenance collector. This is policy vocabulary, not an executor;
 * the owning call site remains responsible for applying every field to its native mechanism. */
export interface Policy {
  readonly mode: "blocking" | "async"
  readonly timeoutMs: number
  readonly retries: number
  readonly retryDelayMs: number
  readonly failureMode: "fail_open" | "fail_closed"
  readonly maxConcurrency: number | "unbounded"
  readonly queueLimit: number | "unbounded"
}

/** A new owned boundary blocks on ambiguity unless its call site deliberately documents why
 * degradation is safer. This is the shared default; every declaration still carries the field. */
export const DEFAULT_FAILURE_MODE = "fail_closed" as const

const MAX_TIMER_MS = 2_147_483_647
const finite = (value: number | undefined, fallback: number, minimum: number) =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.min(MAX_TIMER_MS, Math.floor(value)))

const define = <const T extends Policy>(policy: T): T => Object.freeze(policy)

export const mcpTool = (timeoutMs = 30_000) =>
  define({
    mode: "blocking",
    timeoutMs: finite(timeoutMs, 30_000, 1),
    retries: 0,
    retryDelayMs: 0,
    failureMode: DEFAULT_FAILURE_MODE,
    maxConcurrency: "unbounded",
    queueLimit: 0,
  })

export const webfetch = (timeoutMs = 30_000) =>
  define({
    mode: "blocking",
    timeoutMs: finite(timeoutMs, 30_000, 1),
    retries: 0,
    retryDelayMs: 0,
    failureMode: DEFAULT_FAILURE_MODE,
    // The shared governor owns one slot per host. Waiting happens before this request timeout starts.
    maxConcurrency: 1,
    queueLimit: "unbounded",
  })

export const websearch = (timeoutMs = 8_000, engineCount = 2) =>
  define({
    mode: "blocking",
    timeoutMs: finite(timeoutMs, 8_000, 1),
    retries: 0,
    retryDelayMs: 0,
    // One engine may fail while another supplies a truthful, explicitly degraded result.
    failureMode: "fail_open",
    maxConcurrency: finite(engineCount, 2, 1),
    // The shared governor queues concurrent searches per host rather than swarming that host.
    queueLimit: "unbounded",
  })

export const qualityGate = (timeoutMs = 60_000) =>
  define({
    mode: "blocking",
    timeoutMs: finite(timeoutMs, 60_000, 1),
    retries: 0,
    retryDelayMs: 0,
    // A failed verifier can steer a repair, but it can never count as a passing gate.
    failureMode: DEFAULT_FAILURE_MODE,
    maxConcurrency: 1,
    queueLimit: 0,
  })

export const telemetryLogs = define({
  mode: "async",
  timeoutMs: 3_000,
  retries: 3,
  retryDelayMs: 1_000,
  failureMode: "fail_open",
  maxConcurrency: "unbounded",
  queueLimit: 1_000,
})

export const telemetryTraces = (timeoutMs = 30_000, queueLimit = 2_048) =>
  define({
    mode: "async",
    timeoutMs: finite(timeoutMs, 30_000, 1),
    retries: 0,
    retryDelayMs: 0,
    failureMode: "fail_open",
    maxConcurrency: 1,
    queueLimit: finite(queueLimit, 2_048, 1),
  })

export const summarizer = define({
  mode: "blocking",
  timeoutMs: 300_000,
  retries: 0,
  retryDelayMs: 0,
  // The deterministic packer remains available when semantic compaction cannot answer.
  failureMode: "fail_open",
  maxConcurrency: 1,
  queueLimit: 0,
})

/** The audited default stance for every callout family named by adoption A9.7. */
export const AUDIT = {
  mcp_tool: mcpTool(),
  webfetch: webfetch(),
  websearch: websearch(),
  quality_gate: qualityGate(),
  telemetry_logs: telemetryLogs,
  telemetry_traces: telemetryTraces(),
  summarizer,
} satisfies Readonly<Record<string, Policy>>
