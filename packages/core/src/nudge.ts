export * as Nudge from "./nudge"

import path from "node:path"
import fs from "node:fs/promises"
import vm from "node:vm"
import type { ConfigNudge } from "./config/nudge"
import { validPattern } from "./nudge-definition"

export {
  defaults,
  withDefaults,
  JAVASCRIPT_TIME_ID,
  LOW_RESOURCE_ID,
  NEW_DAY_ID,
  BLOATED_TODO_ID,
  DOOM_LOOP_ID,
  FAILURE_STREAK_ID,
  SESSION_RESTART_ID,
  EMPTY_TURN_ID,
  ANNOUNCED_TOOL_ID,
  FINISH_AUDIT_ID,
  DELEGATE_CHECK_ID,
  PROJECT_OPTIMIZATION_ID,
  PROJECT_CLEANUP_ID,
  STEP_REASONING_ID,
  STEP_TOOL_ID,
  STEP_ANSWER_ID,
  refreshStoredDefault,
  validPattern,
} from "./nudge-definition"

export type Event =
  | {
      readonly type: "tool"
      readonly id: string
      readonly name: string
      readonly input: unknown
      readonly output?: unknown
      readonly phase?: "before" | "after"
    }
  | { readonly type: "compaction"; readonly id: string }
  | { readonly type: "file-edit"; readonly id: string; readonly path: string; readonly sizeBytes: number }
  | {
      readonly type: "resource"
      readonly level: "warning" | "floor"
      readonly bucket: string
      readonly detail?: ReadonlyArray<string>
    }
  | { readonly type: "clock"; readonly at: Date }
  | {
      readonly type: "repeated-tool"
      readonly id: string
      readonly name: string
      readonly input: string
      readonly count: number
      readonly kind: "identical" | "failure"
    }
  | { readonly type: "session-restarted"; readonly id: string }
  | { readonly type: "empty-turn"; readonly id: string; readonly count: number }
  | { readonly type: "announced-tool"; readonly id: string }
  | { readonly type: "finish-audit"; readonly id: string }
  | {
      readonly type: "step-tokens"
      readonly id: string
      readonly channel: "reasoning" | "answer" | "tool"
      readonly tokens: number
    }

export interface Match {
  readonly nudge: ConfigNudge.Info
  readonly occurrence: string
}

export interface ScopedDefinition {
  readonly nudge: ConfigNudge.Info
  readonly deliveryID: string
}

const printable = (value: unknown): string => {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "")
  } catch {
    return String(value)
  }
}

const pathsIn = (value: unknown): ReadonlyArray<string> => {
  if (typeof value !== "object" || value === null) return []
  const found: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if ((key === "path" || key === "file" || key === "filePath" || key === "file_path") && typeof child === "string")
      found.push(child)
    else if (key === "patchText" && typeof child === "string")
      found.push(
        ...child.split("\n").flatMap((line) => {
          const target = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line.trim())?.[1]?.trim()
          return target ? [target] : []
        }),
      )
    else if (typeof child === "object" && child !== null) found.push(...pathsIn(child))
  }
  return found
}

const extensionMatches = (candidate: string, configured: string) => {
  const expected = configured.trim().toLowerCase().replace(/^\./, "")
  return expected !== "" && path.extname(candidate).slice(1).toLowerCase() === expected
}

const toolWrites = new Set(["write", "write-hex", "edit", "apply_patch", "patch"])
const textToolWrites = new Set(["write", "edit", "apply_patch", "patch"])
const toolReads = new Set(["read", "read-hex", "glob", "grep"])

export const editedPaths = (event: Event, directory: string): ReadonlyArray<string> => {
  if (event.type !== "tool" || !textToolWrites.has(event.name)) return []
  if (
    typeof event.output !== "object" ||
    event.output === null ||
    !("type" in event.output) ||
    event.output.type !== "content"
  )
    return []
  return [...new Set(pathsIn(event.input).map((candidate) => path.resolve(directory, candidate)))]
}

export const fileEditEvents = async (
  paths: ReadonlyArray<string>,
  directory: string,
  occurrenceID: string,
): Promise<ReadonlyArray<Extract<Event, { type: "file-edit" }>>> => {
  const result: Array<Extract<Event, { type: "file-edit" }>> = []
  for (const editedPath of new Set(paths.map((candidate) => path.resolve(directory, candidate)))) {
    const file = await fs.stat(editedPath).catch(() => undefined)
    if (file?.isFile())
      result.push({
        type: "file-edit",
        id: `${occurrenceID}:${editedPath}`,
        path: editedPath,
        sizeBytes: file.size,
      })
  }
  return result
}

export const editedFileEvents = (event: Event, directory: string) =>
  fileEditEvents(editedPaths(event, directory), directory, event.type === "tool" ? event.id : "")

const minutes = (value: string): number | undefined => {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : undefined
}

/**
 * The hooks whose trigger is a model reading the session's current context.
 *
 * `ask` gates a static instruction on a yes/no answer; `prompt` carries no body of its own and
 * takes the body the model writes in a fenced block. Both are evaluated on the clock tick, the
 * ambient moment a session already has work in front of it, and only their READER differs.
 */
export type ModelHook = Extract<ConfigNudge.Hook, { type: "ask" } | { type: "prompt" }>

export const isModelHook = (hook: ConfigNudge.Hook): hook is ModelHook => hook.type === "ask" || hook.type === "prompt"

/** The user wording asks for the word yes anywhere in the reply; case-insensitive. */
export const answeredYes = (reply: string): boolean => /\byes\b/i.test(reply)

/**
 * The model's generated body, or nothing.
 *
 * "Triggers when the response contains ```BODY```": a fenced segment is the trigger, and its
 * contents are the body. Both the fenced-with-language-tag shape and an inline fence are accepted,
 * because a model told to "quote result in ```" does not reliably add the newline.
 */
export const fencedBody = (reply: string): string | undefined => {
  const match = /```[^\n`]*\n([\s\S]*?)```/.exec(reply) ?? /```([\s\S]*?)```/.exec(reply)
  const body = match?.[1]?.trim()
  return body ? body : undefined
}

/** The exact rendered question the user specified, with the session context as prefix. */
export const askPrompt = (question: string, context: string): string =>
  `${context}\n\n---\n\nGiven the above, answer exactly "yes" or "no", if the below holds: ${question.trim()}`

/** The exact rendered body request the user specified, with the session context as prefix. */
export const bodyPrompt = (request: string, context: string): string =>
  `${context}\n\n---\n\nGiven the above, generate a prompt fulfilling the below \`\`\`-quoted request\n\`\`\`\n${request.trim()}\n\`\`\`\n\nQuote result in "\`\`\`"`

export function matches(nudge: ConfigNudge.Info, event: Event): boolean {
  if (nudge.enabled === false || (nudge.text.trim() === "" && !nudge.script?.trim() && nudge.hook.type !== "prompt"))
    return false
  const hook = nudge.hook
  switch (hook.type) {
    case "text-match":
      if (event.type !== "tool" || !validPattern(hook.pattern)) return false
      return new RegExp(hook.pattern, "i").test(`${printable(event.input)}\n${printable(event.output)}`)
    case "write-match":
      // 🔴 The INPUT of a writing tool, and nothing else. `text-match` above also reads the tool's
      // OUTPUT, which for a reading tool IS the file — so a nudge meant for code the agent is writing
      // fired on code the agent merely looked at. Measured on this instance 2026-09-12: a `read` of
      // `nudge.test.ts`, whose fixtures contain `done - message.time.created`, delivered the shipped
      // time-safety nudge into a session that was reading; a `bash` one-liner that formatted a SQLite
      // column with `new Date(r.time_created)` delivered it into the owner's. Both firings were
      // "nothing needs saying" — the nudge's own text claims the agent is editing time code, and
      // neither event was an edit. The quiet rule below cannot repair that: it delays a REPEAT, and
      // the first delivery in a session (and the first after every compaction) is by design uncapped.
      if (event.type !== "tool" || !toolWrites.has(event.name) || !validPattern(hook.pattern)) return false
      return new RegExp(hook.pattern, "i").test(printable(event.input))
    case "tool-call":
      return event.type === "tool" && event.name === hook.tool && (hook.phase ?? "after") === (event.phase ?? "after")
    case "shell-command":
      return (
        event.type === "tool" &&
        event.name === "bash" &&
        (hook.phase ?? "after") === (event.phase ?? "after") &&
        validPattern(hook.pattern) &&
        typeof event.input === "object" &&
        event.input !== null &&
        "command" in event.input &&
        typeof event.input.command === "string" &&
        new RegExp(hook.pattern, "i").test(event.input.command)
      )
    case "mcp-call":
      return event.type === "tool" && event.name.startsWith(`${hook.server}_`)
    case "file-read":
      return (
        event.type === "tool" &&
        toolReads.has(event.name) &&
        pathsIn(event.input).some((file) => extensionMatches(file, hook.extension))
      )
    case "file-write":
      return (
        event.type === "tool" &&
        toolWrites.has(event.name) &&
        pathsIn(event.input).some((file) => extensionMatches(file, hook.extension))
      )
    case "javascript":
      if (event.type !== "file-edit" || hook.code.trim() === "") return false
      try {
        return (
          vm.runInNewContext(hook.code, { file: { path: event.path, sizeBytes: event.sizeBytes } }, { timeout: 20 }) ===
          true
        )
      } catch {
        return false
      }
    case "after-compaction":
      return event.type === "compaction"
    case "resource-pressure":
      return event.type === "resource" && (hook.level === "either" || hook.level === event.level)
    case "time-of-day": {
      if (event.type !== "clock") return false
      const after = minutes(hook.after)
      const before = minutes(hook.before)
      if (after === undefined || before === undefined) return false
      const now = event.at.getHours() * 60 + event.at.getMinutes()
      return after <= before ? now >= after && now < before : now >= after || now < before
    }
    case "new-day":
      return event.type === "clock"
    case "interval":
      return event.type === "clock" && Number.isFinite(hook.minutes) && hook.minutes >= 1
    case "script":
      return event.type === "clock" && hook.command.trim() !== ""
    case "repeated-tool":
      return (
        event.type === "repeated-tool" &&
        (hook.tool === undefined || hook.tool.trim() === "" || hook.tool === event.name) &&
        (hook.count === undefined || event.count >= hook.count) &&
        (hook.kind === undefined || hook.kind === event.kind)
      )
    case "session-restarted":
      return event.type === "session-restarted"
    case "empty-turn":
      return event.type === "empty-turn" && (hook.count === undefined || event.count === hook.count)
    case "announced-tool":
      return event.type === "announced-tool"
    case "finish-audit":
      return event.type === "finish-audit"
    case "step-tokens":
      // The step's own count for the channel, so a threshold is a floor the step crossed — not a
      // guess. A step that generated less never fires the hook, whatever the model intended.
      return event.type === "step-tokens" && event.channel === hook.channel && event.tokens >= hook.tokens
    case "ask":
    case "prompt":
      // A model reads the current context; the clock tick is the ambient moment that context is
      // judged, and the quiet rule bounds how often a yes or a written body is delivered.
      return event.type === "clock"
  }
}

export const occurrence = (event: Event): string => {
  if (
    event.type === "tool" ||
    event.type === "compaction" ||
    event.type === "file-edit" ||
    event.type === "repeated-tool" ||
    event.type === "session-restarted" ||
    event.type === "empty-turn" ||
    event.type === "announced-tool" ||
    event.type === "finish-audit" ||
    event.type === "step-tokens"
  )
    return `${event.type}:${event.id}`
  if (event.type === "resource") return `resource:${event.level}:${event.bucket}`
  const year = event.at.getFullYear()
  const month = String(event.at.getMonth() + 1).padStart(2, "0")
  const day = String(event.at.getDate()).padStart(2, "0")
  return `clock:${year}-${month}-${day}`
}

export const occurrenceFor = (nudge: ConfigNudge.Info, event: Event): string =>
  event.type === "clock" && nudge.hook.type === "interval"
    ? `interval:${Math.floor(event.at.getTime() / (nudge.hook.minutes * 60_000))}`
    : event.type === "clock" && isModelHook(nudge.hook)
      ? // A fresh occurrence per tick: a model-judged nudge is not a calendar period, it is an
        // EVENT ("the model said yes this time"), so the ordinary quiet rule — 30 minutes and one
        // context epoch — is the bound on repeats. A clock-day occurrence would also swallow the
        // second yes of a busy day, which is not what a judged trigger means.
        `model:${event.at.getTime()}`
      : occurrence(event)

/**
 * Whether an occurrence names a **period** rather than an **event**.
 *
 * 🔴 This distinction is what makes the quiet rule fair. A `tool:` occurrence is unique per tool
 * call — it has no intrinsic period at all, so without an epoch cap the same instruction could be
 * delivered thousands of times in one context, which is the spam the owner reported. A `clock:` or
 * `resource:` occurrence IS the period (`clock:2026-09-12`, `resource:warning:mem`): it cannot
 * repeat inside that period by construction, so demanding an intervening compaction as well would
 * silently swallow the new-day notice in a session that happens not to compact overnight.
 *
 * `script:` occurrences are hashes of the hook's output, so they change exactly as often as the
 * output does — that is repetition by construction, and such a nudge needs `spammable` to be chatty.
 */
export const periodic = (occurrence: string): boolean =>
  occurrence.startsWith("clock:") || occurrence.startsWith("resource:") || occurrence.startsWith("interval:")

/**
 * 🔴 **THE QUIET RULE.** How long a delivered nudge stays silenced before the same one may be
 * delivered to the same session again.
 *
 * The owner's report, 2026-09-11: *"nudges by default same nudge can't be inserted more than once
 * per session compaction and per 30 minutes. Otherwise the nudges, like the js time code, gets
 * spammed a lot."* The mechanism behind the complaint is `occurrence()`: a `tool:` occurrence is
 * `tool:<event.id>`, unique per tool call, so the shipped time-safety nudge — a `text-match` on
 * timestamp arithmetic — cleared the replay guard on EVERY edit that touched a `createdAt`, and each
 * delivery pushed a fresh paragraph into the transcript the model was trying to work in.
 *
 * Two caps, and both have to clear, which is why the silence lasts as long as the LONGER of them:
 * once per 30 minutes, and once per context epoch. The interval bounds a session that compacts in a
 * thrash; the epoch bounds a session that runs for hours without one.
 */
export const QUIET_INTERVAL_MS = 30 * 60_000

/**
 * Whether a nudge that ALREADY reached this session may reach it again.
 *
 * Pure, and deliberately so: the whole policy is answerable from three numbers and a string, so it
 * can be argued about without a database. `nudge-service.ts` supplies the numbers.
 *
 * `compactedAfter` is "a compaction happened after that delivery" — the durable form of "the context
 * this was delivered into no longer exists". Losing the reminder to compaction is the one legitimate
 * reason to repeat it; losing it to the model simply continuing is not.
 */
export const deliverable = (input: {
  readonly prior: Readonly<{ occurrence: string; firedAt: number }>
  readonly occurrence: string
  readonly spammable: boolean
  readonly now: number
  readonly compactedAfter: boolean
}): boolean => {
  // The same occurrence twice is a replay, not a repeat — that guard predates this rule and stays.
  if (input.prior.occurrence === input.occurrence) return false
  if (input.spammable) return true
  if (!periodic(input.occurrence) && input.now - input.prior.firedAt < QUIET_INTERVAL_MS) return false
  if (!periodic(input.occurrence) && !input.compactedAfter) return false
  return true
}

export const select = (definitions: readonly ConfigNudge.Info[], event: Event): ReadonlyArray<Match> =>
  definitions
    .filter((nudge) => matches(nudge, event))
    .map((nudge) => ({ nudge, occurrence: occurrenceFor(nudge, event) }))

export const prompt = (nudge: ConfigNudge.Info, event?: Event): string =>
  [
    `Nudge — ${nudge.name}: ${nudge.text.trim()}`,
    `Will recur; to disable call nudge({"op":"disable","id":${JSON.stringify(nudge.id)}}).`,
    ...(event?.type === "resource" && event.detail?.length ? ["Current resource status:", ...event.detail] : []),
  ].join("\n")
