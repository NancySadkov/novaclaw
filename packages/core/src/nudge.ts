export * as Nudge from "./nudge"

import path from "node:path"
import type { ConfigNudge } from "./config/nudge"

export const LOW_RESOURCE_ID = "builtin-low-resources"
export const JAVASCRIPT_TIME_ID = "builtin-javascript-time-safety"

export const defaults = (): ReadonlyArray<ConfigNudge.Info> => [
  {
    id: LOW_RESOURCE_ID,
    name: "Protect work when resources run low",
    enabled: true,
    agents: [],
    hook: { type: "resource-pressure", level: "either" },
    text:
      "This instance is low on memory or disk headroom. Avoid starting memory- or disk-intensive work. " +
      "Use tool_search for resource status, then resource_status for the live figures and confirm recovery before resuming heavy work.",
  },
  {
    id: JAVASCRIPT_TIME_ID,
    name: "Check JavaScript time conversions",
    enabled: true,
    agents: [],
    hook: {
      type: "text-match",
      pattern:
        "(?:[-+]\\s*(?:(?:[\\w$]+\\.)*time\\.(?:created|completed)|createdAt|completedAt|startedAt|endedAt)|(?:(?:[\\w$]+\\.)*time\\.(?:created|completed)|createdAt|completedAt|startedAt|endedAt)\\s*[-+]|new\\s+Date\\([^)]*(?:created|completed|started|ended|timestamp))",
    },
    text: "You are editing JavaScript/TypeScript time code. Before continuing, verify every value's runtime shape at its transport/schema boundary and normalize it before subtraction or formatting. Guard non-finite results so an invalid conversion can never render NaN.",
  },
]

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

export const resolved = (stored: readonly ConfigNudge.Info[] | undefined): ReadonlyArray<ConfigNudge.Info> =>
  stored === undefined ? defaults() : stored

const appliesTo = (nudge: ConfigNudge.Info, agentID: string | undefined) =>
  !nudge.agents?.length || (agentID !== undefined && nudge.agents.includes(agentID))

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

export const validPattern = (pattern: string): boolean => {
  try {
    new RegExp(pattern, "i")
    return pattern.trim() !== ""
  } catch {
    return false
  }
}

export function matches(nudge: ConfigNudge.Info, event: Event, agentID?: string): boolean {
  if (nudge.enabled === false || nudge.text.trim() === "" || !appliesTo(nudge, agentID)) return false
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

export const select = (
  definitions: readonly ConfigNudge.Info[],
  event: Event,
  agentID?: string,
): ReadonlyArray<Match> =>
  definitions
    .filter((nudge) => matches(nudge, event, agentID))
    .map((nudge) => ({ nudge, occurrence: occurrence(event) }))

export const prompt = (nudge: Pick<ConfigNudge.Info, "name" | "text">, event?: Event): string =>
  [
    `Nudge — ${nudge.name}: ${nudge.text.trim()}`,
    ...(event?.type === "resource" && event.detail?.length ? ["Current resource status:", ...event.detail] : []),
  ].join("\n")
