export * as Nudge from "./nudge"

import path from "node:path"
import type { ConfigNudge } from "./config/nudge"
import { resolved, validPattern } from "./nudge-definition"

export { defaults, JAVASCRIPT_TIME_ID, LOW_RESOURCE_ID, NEW_DAY_ID, resolved, validPattern } from "./nudge-definition"

export type Event =
  | {
      readonly type: "tool"
      readonly id: string
      readonly name: string
      readonly input: unknown
      readonly output?: unknown
    }
  | { readonly type: "compaction"; readonly id: string }
  | {
      readonly type: "resource"
      readonly level: "warning" | "floor"
      readonly bucket: string
      readonly detail?: ReadonlyArray<string>
    }
  | { readonly type: "clock"; readonly at: Date }

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
const toolReads = new Set(["read", "read-hex", "glob", "grep"])

const minutes = (value: string): number | undefined => {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : undefined
}

export function matches(nudge: ConfigNudge.Info, event: Event): boolean {
  if (nudge.enabled === false || (nudge.text.trim() === "" && !nudge.script?.trim())) return false
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
      return event.type === "tool" && event.name === hook.tool
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
    case "script":
      return event.type === "clock" && hook.command.trim() !== ""
  }
}

export const occurrence = (event: Event): string => {
  if (event.type === "tool" || event.type === "compaction") return `${event.type}:${event.id}`
  if (event.type === "resource") return `resource:${event.level}:${event.bucket}`
  const year = event.at.getFullYear()
  const month = String(event.at.getMonth() + 1).padStart(2, "0")
  const day = String(event.at.getDate()).padStart(2, "0")
  return `clock:${year}-${month}-${day}`
}

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
export const periodic = (occurrence: string): boolean => occurrence.startsWith("clock:") || occurrence.startsWith("resource:")

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
  if (input.now - input.prior.firedAt < QUIET_INTERVAL_MS) return false
  if (!periodic(input.occurrence) && !input.compactedAfter) return false
  return true
}

export const select = (definitions: readonly ConfigNudge.Info[], event: Event): ReadonlyArray<Match> =>
  definitions.filter((nudge) => matches(nudge, event)).map((nudge) => ({ nudge, occurrence: occurrence(event) }))

export const prompt = (nudge: Pick<ConfigNudge.Info, "name" | "text">, event?: Event): string =>
  [
    `Nudge — ${nudge.name}: ${nudge.text.trim()}`,
    ...(event?.type === "resource" && event.detail?.length ? ["Current resource status:", ...event.detail] : []),
  ].join("\n")
