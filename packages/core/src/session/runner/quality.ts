export * as Quality from "./quality"

// QE (Quality Enforcement) — the deterministic half of the 5-step verify loop
// (QE-B), pure and unit-testable: which checks fire when, over the projected
// context. The runner executes the PROVISIONED commands (QE-C config; QE-A's
// provisioner fills them later — today the user provisions via config/the tab)
// and lowers each failure as a steer observation the model must resolve — a
// failed check is a retryable observation (1D philosophy), never a halt.
//
// Step map (todo.md QE-B):
//   1 syntax    — per touched file, on every write-class tool result
//   2 check     — per touched file (the provisioned incremental verifier)
//   3 typecheck — every `cadence`-th write (default 2), whole-module
//   4 test      — once per drain, at turn end, when the drain wrote anything
//   5 lint      — the structural pass, same turn-end gate as 4
// A missing command skips its step ("not everything has an automatic check").

import type { SessionMessage } from "../message"

export interface Commands {
  readonly syntax?: string
  readonly check?: string
  readonly typecheck?: string
  readonly test?: string
  readonly lint?: string
}

export interface Config {
  readonly enabled: boolean
  /** Run the whole-module typecheck every N writes (default 2, min 1). */
  readonly cadence: number
  /** Hard timeout for the test gate, ms (default 300 000). */
  readonly testTimeout: number
  readonly commands: Commands
}

export const DEFAULTS: Config = { enabled: false, cadence: 2, testTimeout: 300_000, commands: {} }

/** Raw config block as it appears on `Config.Info` (all optional). */
export interface RawConfig {
  readonly enabled?: boolean
  readonly cadence?: number
  readonly testTimeout?: number
  readonly commands?: Commands
}

export function resolve(raw: RawConfig | undefined): Config {
  return {
    enabled: raw?.enabled === true,
    cadence: raw?.cadence !== undefined && raw.cadence >= 1 ? Math.floor(raw.cadence) : DEFAULTS.cadence,
    testTimeout:
      raw?.testTimeout !== undefined && raw.testTimeout >= 1_000 ? Math.floor(raw.testTimeout) : DEFAULTS.testTimeout,
    commands: raw?.commands ?? {},
  }
}

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "write-hex"])

/**
 * Files touched by write-class tool calls in the NEWEST assistant message
 * (the turn that just settled). Reads the projected V2 context; `path` is the
 * mutation tools' input field.
 */
export function writeTargets(context: readonly SessionMessage.Message[]): string[] {
  const newest = [...context].reverse().find((message) => message.type === "assistant")
  if (!newest || newest.type !== "assistant") return []
  const files: string[] = []
  for (const part of newest.content) {
    if (part.type !== "tool" || !WRITE_TOOLS.has(part.name)) continue
    if (part.state.status !== "completed") continue
    const input = part.state.input as { path?: unknown; filePath?: unknown }
    const file = typeof input.path === "string" ? input.path : typeof input.filePath === "string" ? input.filePath : undefined
    if (file) files.push(file)
  }
  return [...new Set(files)]
}

/** Substitute the touched file into a provisioned command template. */
export function renderCommand(template: string, file: string): string {
  // Quote for the shell: double quotes cover spaces on cmd.exe AND sh.
  return template.includes("{file}") ? template.replaceAll("{file}", `"${file}"`) : `${template} "${file}"`
}

export interface DueCheck {
  readonly step: 1 | 2 | 3
  readonly label: "syntax" | "check" | "typecheck"
  readonly command: string
}

/** Mutable per-drain state (the runner owns one per run()). */
export interface State {
  writes: number
  turnEndDone: boolean
}

export function initialState(): State {
  return { writes: 0, turnEndDone: false }
}

/** Mid-loop checks due for a settled turn that touched `files`. Mutates state.writes. */
export function dueMidLoop(config: Config, state: State, files: readonly string[]): DueCheck[] {
  if (!config.enabled || files.length === 0) return []
  const due: DueCheck[] = []
  for (const file of files) {
    state.writes++
    if (config.commands.syntax) due.push({ step: 1, label: "syntax", command: renderCommand(config.commands.syntax, file) })
    if (config.commands.check) due.push({ step: 2, label: "check", command: renderCommand(config.commands.check, file) })
    if (config.commands.typecheck && state.writes % config.cadence === 0)
      due.push({ step: 3, label: "typecheck", command: config.commands.typecheck })
  }
  return due
}

export interface TurnEndCheck {
  readonly step: 4 | 5
  readonly label: "test" | "lint"
  readonly command: string
  readonly timeoutMs: number
}

/** Turn-end gate (steps 4+5): once per drain, only when the drain wrote anything. */
export function dueTurnEnd(config: Config, state: State): TurnEndCheck[] {
  if (!config.enabled || state.turnEndDone || state.writes === 0) return []
  state.turnEndDone = true
  const due: TurnEndCheck[] = []
  if (config.commands.test) due.push({ step: 4, label: "test", command: config.commands.test, timeoutMs: config.testTimeout })
  if (config.commands.lint) due.push({ step: 5, label: "lint", command: config.commands.lint, timeoutMs: 120_000 })
  return due
}

const tail = (text: string, max = 1500) => (text.length <= max ? text : `…${text.slice(-max)}`)

/** The steer lowered for a failed check — an observation to resolve, never a halt. */
export function failureMessage(input: {
  readonly label: string
  readonly command: string
  readonly output: string
  readonly exit?: number
  readonly timedOut?: boolean
}): string {
  const why = input.timedOut
    ? `timed out (hung or looping — treat as a failure)`
    : `failed with exit ${input.exit ?? "?"}`
  return (
    `Quality gate: the ${input.label} check ${why}.\n` +
    `Command: ${input.command}\n` +
    `Output (tail):\n${tail(input.output) || "(no output)"}\n` +
    `The change does not count as done until this passes. Fix the underlying problem and re-run the check — ` +
    `never silence it (no || true, no ignoring the failing assertion: a check must fail when the thing is broken).`
  )
}
