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

export const select = (definitions: readonly ConfigNudge.Info[], event: Event): ReadonlyArray<Match> =>
  definitions.filter((nudge) => matches(nudge, event)).map((nudge) => ({ nudge, occurrence: occurrence(event) }))

export const prompt = (nudge: Pick<ConfigNudge.Info, "name" | "text">, event?: Event): string =>
  [
    `Nudge — ${nudge.name}: ${nudge.text.trim()}`,
    ...(event?.type === "resource" && event.detail?.length ? ["Current resource status:", ...event.detail] : []),
  ].join("\n")
