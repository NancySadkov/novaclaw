export * as ToolTruncation from "./truncation"

/** How an oversized text tool result spends its provider-facing preview budget. */
export type PreviewPolicy = "balanced" | "earliest"

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join("")
}

export const lineCount = (text: string) => {
  let count = 1
  for (const char of text) if (char === "\n") count++
  return count
}

const balanced = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled, "utf-8") <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

/**
 * Build the bounded provider preview after the complete output has been retained on disk.
 *
 * Search-like results use `earliest`: ordering carries relevance, so the first matches and a
 * legible summary beat a generic head/tail sample that spends half the window on late matches.
 * Other tools keep `balanced`, where the tail often contains the error or command conclusion.
 */
export const boundedPreview = (input: {
  readonly text: string
  readonly marker: string
  readonly maxLines: number
  readonly maxBytes: number
  readonly policy: PreviewPolicy
}) => {
  const markerOnly = takePrefix(input.marker, input.maxBytes).split("\n").slice(0, input.maxLines).join("\n")
  const markerBytes = Buffer.byteLength(input.marker, "utf-8")
  if (input.maxLines <= 2 || input.maxBytes <= markerBytes + 2) return markerOnly

  if (input.policy === "earliest") {
    const prefix = takePrefix(
      input.text
        .split("\n")
        .slice(0, input.maxLines - 2)
        .join("\n"),
      input.maxBytes - markerBytes - 2,
    )
    return prefix.length === 0 ? markerOnly : `${prefix}\n\n${input.marker}`
  }

  if (input.maxLines <= 4 || input.maxBytes <= markerBytes + 4) return markerOnly
  const preview = balanced(input.text, input.maxLines - 4, input.maxBytes - markerBytes - 4)
  return preview.tail ? `${preview.head}\n\n${input.marker}\n\n${preview.tail}` : `${preview.head}\n\n${input.marker}`
}
