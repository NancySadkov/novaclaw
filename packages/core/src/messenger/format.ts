export * as MessengerFormat from "./format"

// Outbound text shaping (notes/messenger-plan.md §3.2): downgrade the assistant's markdown to
// what the platform can render, then chunk to the platform budget. IRC budgets BYTES per line
// (RFC 1459), so byte-mode chunking must never split a UTF-8 code point; character platforms
// (Telegram 4096, Discord 2000) budget UTF-16 units — what both they and JS `.length` count.
// Pure functions, unit-tested; the gateway is the only caller.

export type Flavor = "plain" | "markdown" | "html"

const encoder = new TextEncoder()

export const utf8Length = (text: string): number => encoder.encode(text).length

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

// Shared inline-markdown passes. Order matters: fences first (their bodies must not be
// re-interpreted), then links, then emphasis/code decoration.
const stripFences = (text: string, wrap?: (body: string) => string): string =>
  text.replaceAll(/```[^\n]*\n([\s\S]*?)```/g, (_, body: string) => (wrap ? wrap(body.replace(/\n$/, "")) : body.replace(/\n$/, "")))

const plainInline = (text: string): string =>
  text
    .replaceAll(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, label: string, url: string) => (label ? `${label} (${url})` : url))
    .replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => `${label} (${url})`)
    .replaceAll(/\*\*([^*]+)\*\*/g, "$1")
    .replaceAll(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "$1")
    .replaceAll(/`([^`\n]+)`/g, "$1")

const plainLine = (line: string): string => {
  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
  if (heading?.[2] !== undefined) return heading[2]
  return line.replace(/^\s{0,3}>\s?/, "")
}

/** Downgrade markdown to the platform flavor. `markdown` passes through untouched; `plain`
 *  strips decoration but keeps every word; `html` is the minimal Telegram-safe mapping
 *  (escape everything, then bold/code/pre from the markdown that survives). */
export function downgrade(text: string, flavor: Flavor): string {
  if (flavor === "markdown") return text
  if (flavor === "plain") {
    const unfenced = stripFences(text)
    return plainInline(unfenced)
      .split("\n")
      .map(plainLine)
      .join("\n")
  }
  // html: escape FIRST so user content can't smuggle tags, then decorate.
  const escaped = escapeHtml(text)
  const fenced = stripFences(escaped, (body) => `<pre>${body}</pre>`)
  return fenced
    .split("\n")
    .map((line) => {
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
      return heading?.[2] !== undefined ? `<b>${heading[2]}</b>` : line
    })
    .join("\n")
    .replaceAll(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replaceAll(/`([^`\n]+)`/g, "<code>$1</code>")
}

export interface Budget {
  readonly maxChars: number
  /** Set → measure UTF-8 bytes instead of UTF-16 units (IRC). */
  readonly maxBytes?: number
}

const measure = (text: string, budget: Budget): number =>
  budget.maxBytes !== undefined ? utf8Length(text) : text.length

const limit = (budget: Budget): number => budget.maxBytes ?? budget.maxChars

/** Hard-split by code points so a byte budget never severs a UTF-8 sequence (and a char budget
 *  never severs a surrogate pair — `for..of` walks code points). */
const hardSplit = (text: string, budget: Budget): string[] => {
  const out: string[] = []
  let current = ""
  for (const cp of text) {
    if (measure(current + cp, budget) > limit(budget) && current.length > 0) {
      out.push(current)
      current = ""
    }
    current += cp
  }
  if (current.length > 0) out.push(current)
  return out
}

const splitBy = (parts: readonly string[], joiner: string, budget: Budget, refine: (part: string) => string[]): string[] => {
  const out: string[] = []
  let current = ""
  const flush = () => {
    if (current.length > 0) out.push(current)
    current = ""
  }
  for (const part of parts) {
    if (measure(part, budget) > limit(budget)) {
      flush()
      out.push(...refine(part))
      continue
    }
    const candidate = current.length === 0 ? part : current + joiner + part
    if (measure(candidate, budget) > limit(budget)) {
      flush()
      current = part
    } else {
      current = candidate
    }
  }
  flush()
  return out
}

/** Split `text` into platform-sized chunks, preferring paragraph > line > word boundaries and
 *  hard-splitting only as a last resort. Never returns an empty chunk; empty input → []. */
export function chunk(text: string, budget: Budget): string[] {
  if (text.length === 0) return []
  if (measure(text, budget) <= limit(budget)) return [text]
  return splitBy(text.split("\n\n"), "\n\n", budget, (paragraph) =>
    splitBy(paragraph.split("\n"), "\n", budget, (line) =>
      splitBy(line.split(" "), " ", budget, (word) => hardSplit(word, budget)),
    ),
  )
}
