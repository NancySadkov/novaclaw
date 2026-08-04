export * as TodoReminder from "./todo-reminder"

import type { ConfigContext } from "../../config/context"
import type { SessionTodo } from "../todo"
import { applySteerProvenance } from "../steer-provenance"
import { Token } from "../../util/token"

export const DEFAULT_CADENCE = 6
export const DEFAULT_MAX_TOKENS = 256
export const MIN_MAX_TOKENS = 64
export const MAX_MAX_TOKENS = 4096
export const MAX_CADENCE = 1000

export interface Resolved {
  readonly enabled: boolean
  readonly cadence: number
  readonly maxTokens: number
}

export interface ReminderState {
  readonly cadence: number
  readonly bucket: number
}

const whole = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

/** Runtime-total projection of the live Tune. Direct config edits cannot create a zero cadence or
 * an unbounded reminder even if they bypass the Settings input constraints. */
export const resolve = (config: ConfigContext.TodoReminder | undefined): Resolved => ({
  enabled: config?.enabled ?? true,
  cadence: whole(config?.cadence, DEFAULT_CADENCE, 1, MAX_CADENCE),
  maxTokens: whole(config?.max_tokens, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS),
})

/** The durable sequence bucket due now, or undefined when this cadence bucket was already served.
 * SessionHistory preserves the latest durable seq across compaction overlays, so summary churn cannot
 * reset this clock. A cadence change gets its own state key and therefore takes effect immediately. */
export const due = (
  sequence: number,
  config: Pick<Resolved, "cadence">,
  previous: ReminderState | undefined,
): ReminderState | undefined => {
  if (sequence < config.cadence) return undefined
  const next = { cadence: config.cadence, bucket: Math.floor(sequence / config.cadence) }
  return previous?.cadence === next.cadence && previous.bucket === next.bucket ? undefined : next
}

const STATUS_ORDER: Readonly<Record<string, number>> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}
const PRIORITY_ORDER: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 }

const label = (value: string) => value.trim().toLowerCase().replaceAll("_", " ") || "unknown"
const line = (todo: SessionTodo.Info) => `- [${label(todo.status)}] ${todo.content.trim()} (${label(todo.priority)})`
const omittedLine = (count: number) =>
  `- … ${count} more checklist ${count === 1 ? "item" : "items"} omitted by the reminder budget.`
const INTRO = applySteerProvenance(
  "Task checklist reminder — continue from this plan and keep it current with `todowrite`:",
)

const compose = (lines: readonly string[], omitted: number) =>
  [INTRO, ...lines, ...(omitted > 0 ? [omittedLine(omitted)] : [])].join("\n")

const fitLine = (value: string, render: (candidate: string) => string, maxTokens: number): string | undefined => {
  if (Token.estimate(render(value)) <= maxTokens) return value
  const chars = Array.from(value)
  let low = 0
  let high = chars.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${chars.slice(0, middle).join("").trimEnd()}…`
    if (Token.estimate(render(candidate)) <= maxTokens) low = middle
    else high = middle - 1
  }
  if (low === 0) return undefined
  let result = `${chars.slice(0, low).join("").trimEnd()}…`
  while (result.length > 1 && Token.estimate(render(result)) > maxTokens) {
    result = `${Array.from(result.slice(0, -1)).slice(0, -1).join("").trimEnd()}…`
  }
  return Token.estimate(render(result)) <= maxTokens ? result : undefined
}

/** Build a provider-only reminder. Active work wins the budget, the full checklist stays in SQLite,
 * and an omission marker makes projection loss explicit instead of silently pretending the list fit. */
export const render = (todos: readonly SessionTodo.Info[], maxTokens: number): string | undefined => {
  if (todos.length === 0) return undefined
  const ordered = todos
    .map((todo, index) => ({ todo, index }))
    .toSorted(
      (left, right) =>
        (STATUS_ORDER[left.todo.status] ?? 4) - (STATUS_ORDER[right.todo.status] ?? 4) ||
        (PRIORITY_ORDER[left.todo.priority] ?? 3) - (PRIORITY_ORDER[right.todo.priority] ?? 3) ||
        left.index - right.index,
    )
    .map(({ todo }) => line(todo))

  const selected: string[] = []
  for (let index = 0; index < ordered.length; index++) {
    const candidate = ordered[index]!
    const omitted = ordered.length - index - 1
    if (Token.estimate(compose([...selected, candidate], omitted)) <= maxTokens) {
      selected.push(candidate)
      continue
    }
    if (selected.length === 0) {
      const fitted = fitLine(candidate, (value) => compose([value], ordered.length - 1), maxTokens)
      if (fitted !== undefined) selected.push(fitted)
    }
    break
  }
  return compose(selected, ordered.length - selected.length)
}
