import type { SessionMessage } from "@novaclaw/sdk/v2/client"
import type { SessionContextBreakdownKey } from "./session-context-breakdown"

const serialize = (records: readonly unknown[]) => records.map((record) => JSON.stringify(record, null, 2)).join("\n\n")

export function serializeSessionTranscript(messages: readonly SessionMessage[]): string {
  return serialize(messages)
}

export function downloadPlainText(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Preserve the native wire records in every export. Assistant messages contain both prose/reasoning
 * and tool parts, so the two corresponding downloads narrow only their inline `content` array while
 * leaving the surrounding message metadata intact. "Other" is provider/tool-schema overhead rather
 * than a native message; its record says that honestly instead of inventing source text for it.
 */
export function serializeContextSegment(input: {
  key: SessionContextBreakdownKey
  messages: readonly SessionMessage[]
  estimatedTokens: number
}): string {
  if (input.key === "system") return serialize(input.messages.filter((message) => message.type === "system"))
  if (input.key === "user") return serialize(input.messages.filter((message) => message.type === "user"))

  if (input.key === "other") {
    return serialize([
      {
        type: "context-overhead",
        estimatedTokens: input.estimatedTokens,
        note: "Estimated provider context not represented by a native session message, including tool definitions and protocol overhead.",
      },
    ])
  }

  const contentType = (content: { type: string }) =>
    input.key === "assistant"
      ? content.type === "text" || content.type === "reasoning"
      : content.type !== "text" && content.type !== "reasoning"

  return serialize(
    input.messages.flatMap((message) => {
      if (message.type !== "assistant") return []
      const content = message.content.filter(contentType)
      return content.length > 0 ? [{ ...message, content }] : []
    }),
  )
}

export function sessionExportFilename(name: string, suffix: string, extension: "txt" | "json" = "txt"): string {
  const stem = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return `${stem || "session"}-${suffix}.${extension}`
}
