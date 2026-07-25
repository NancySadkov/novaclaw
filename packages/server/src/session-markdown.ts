export * as SessionMarkdown from "./session-markdown"

import type { SessionMessage } from "@novaclaw/schema/session-message"

// Render a session as a readable Markdown transcript (the Chats app's "Export as Markdown").
//
// Deliberately a PURE function over an already-ordered message array: the caller owns fetching (and
// owns asking for `order: "asc"` — the message API is newest-first by default, which has bitten this
// codebase before). That keeps the shape testable without a database.
//
// A session that is still RUNNING is exported as-is rather than blocked or refused: whatever exists is
// written, any in-flight tool is marked, and a closing note records that the transcript was captured
// mid-turn. Silently emitting a truncated transcript that LOOKS finished is the one outcome to avoid.

export interface Options {
  readonly title?: string
  readonly sessionID: string
  readonly directory?: string
  /** Milliseconds. Passed in rather than read from the clock so the output is testable. */
  readonly exportedAt: number
}

export interface Result {
  readonly markdown: string
  readonly messageCount: number
  /** True when the tail of the transcript was still being produced as we exported. */
  readonly running: boolean
}

/**
 * Timestamps arrive in two shapes and this must survive both. Over the wire `time.created` is a number
 * (milliseconds), but the schema field is `DateTimeUtcFromMillis`, so the DECODED value the server hands
 * us is an Effect `DateTime.Utc` object carrying `epochMillis`. Passing that object to `new Date()`
 * yields an Invalid Date and `toISOString()` THROWS — which surfaced as an opaque UnknownError on every
 * session that actually had messages. Never throw here: an unformattable timestamp is simply omitted.
 */
const iso = (value: unknown): string | undefined => {
  const millis =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : typeof value === "object" && value !== null && typeof (value as { epochMillis?: unknown }).epochMillis === "number"
          ? (value as { epochMillis: number }).epochMillis
          : undefined
  if (millis === undefined || !Number.isFinite(millis)) return undefined
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** A fence long enough to survive content that itself contains backticks. */
const fence = (body: string): string => {
  let ticks = 3
  for (const run of body.match(/`{3,}/g) ?? []) ticks = Math.max(ticks, run.length + 1)
  return "`".repeat(ticks)
}

const codeBlock = (body: string, lang = ""): string => {
  const f = fence(body)
  return `${f}${lang}\n${body.replace(/\s+$/, "")}\n${f}`
}

const truncate = (text: string, max = 4000): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`

/** `{ input, output }` off a tool part, whatever its status. */
function toolIO(state: Record<string, unknown>): { input?: unknown; output?: unknown; error?: string } {
  const status = state["status"]
  const out: { input?: unknown; output?: unknown; error?: string } = {}
  if (status !== "pending") out.input = state["input"]
  if (status === "completed") out.output = state["output"]
  if (status === "error") {
    const error = state["error"] as { message?: string } | undefined
    out.error = error?.message ?? "failed"
  }
  return out
}

function renderTool(part: Record<string, unknown>, lines: string[]): boolean {
  const state = (part["state"] ?? {}) as Record<string, unknown>
  const status = String(state["status"] ?? "unknown")
  const name = String(part["name"] ?? "tool")
  const running = status === "running" || status === "pending"
  lines.push(`> **Tool — ${name}** · ${running ? `${status} (still in flight at export)` : status}`)
  const io = toolIO(state)
  if (io.input !== undefined) {
    lines.push("", "<details><summary>Input</summary>", "", codeBlock(truncate(json(io.input)), "json"), "", "</details>")
  }
  if (io.output !== undefined) {
    const text = typeof io.output === "string" ? io.output : json(io.output)
    lines.push("", "<details><summary>Output</summary>", "", codeBlock(truncate(text)), "", "</details>")
  }
  if (io.error !== undefined) lines.push("", `> Failed: ${io.error}`)
  lines.push("")
  return running
}

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function render(messages: readonly SessionMessage.Message[], options: Options): Result {
  const lines: string[] = []
  let running = false

  lines.push(`# ${options.title?.trim() || "Session"}`, "")
  lines.push(`- Session: \`${options.sessionID}\``)
  if (options.directory) lines.push(`- Folder: \`${options.directory}\``)
  lines.push(`- Exported: ${iso(options.exportedAt)}`)
  lines.push(`- Messages: ${messages.length}`, "")
  lines.push("---", "")

  for (const message of messages) {
    const m = message as unknown as Record<string, unknown>
    const type = String(m["type"] ?? "unknown")
    const time = (m["time"] ?? {}) as { created?: unknown; completed?: unknown }
    const stamp = iso(time.created)

    if (type === "user") {
      lines.push(`## User${stamp ? ` · ${stamp}` : ""}`, "")
      const text = String(m["text"] ?? "").trim()
      if (text) lines.push(text, "")
      const files = (m["files"] ?? []) as Array<{ name?: string; mime?: string }>
      if (files.length) lines.push(`Attachments: ${files.map((f) => f.name ?? f.mime ?? "file").join(", ")}`, "")
      continue
    }

    if (type === "assistant") {
      const model = (m["model"] ?? {}) as { providerID?: string; id?: string }
      const label = model.id ? `${model.providerID ?? ""}/${model.id}`.replace(/^\//, "") : undefined
      lines.push(`## Assistant${label ? ` · ${label}` : ""}${stamp ? ` · ${stamp}` : ""}`, "")
      const content = (m["content"] ?? []) as Array<Record<string, unknown>>
      for (const part of content) {
        const kind = String(part["type"] ?? "")
        if (kind === "reasoning") {
          const text = String(part["text"] ?? "").trim()
          if (text) lines.push("<details><summary>Reasoning</summary>", "", truncate(text), "", "</details>", "")
        } else if (kind === "text") {
          const text = String(part["text"] ?? "").trim()
          if (text) lines.push(text, "")
        } else if (kind === "tool") {
          if (renderTool(part, lines)) running = true
        }
      }
      // `finish` is null while the turn is still being produced.
      if (m["finish"] === null || m["finish"] === undefined) running = true
      const tokens = (m["tokens"] ?? {}) as { input?: number; output?: number; reasoning?: number }
      if (tokens.output !== undefined)
        lines.push(
          `_tokens: ${tokens.input ?? 0} in · ${tokens.output ?? 0} out${tokens.reasoning ? ` · ${tokens.reasoning} reasoning` : ""}_`,
          "",
        )
      continue
    }

    // shell / system / synthetic / compaction and anything added later: keep it, labelled, rather
    // than dropping content we do not have a bespoke renderer for.
    const text = String(m["text"] ?? "").trim()
    lines.push(`## ${type[0]?.toUpperCase()}${type.slice(1)}${stamp ? ` · ${stamp}` : ""}`, "")
    if (text) lines.push(text, "")
  }

  if (running) {
    lines.push("---", "")
    lines.push(
      "> **This session was still running when it was exported.** The transcript above ends mid-turn —",
      "> any tool marked *still in flight* had not returned, and later output is missing. Export again",
      "> once the run finishes for the complete record.",
      "",
    )
  }

  return { markdown: lines.join("\n"), messageCount: messages.length, running }
}

/** A filesystem-safe basename for the export, e.g. `hello-c-ses_abc123.md`. */
export function filename(options: { title?: string; sessionID: string }): string {
  const slug = (options.title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return `${slug ? `${slug}-` : ""}${options.sessionID}.md`
}
