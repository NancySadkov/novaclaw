import { marked, type Tokens } from "marked"
import remend from "remend"
import { htmlEmbedLanguage } from "./markdown-html-embed"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live" | "code"
  language?: string
  complete?: boolean
}

export type Projection = {
  text: string
  blocks: Block[]
}

function refs(text: string) {
  if (!text.includes("]:")) return false
  return /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(?:\S+|\r?\n[ \t]+\S+)/m.test(text)
}

function language(value: string | undefined) {
  // Lowercased at the source: shiki's bundledLanguages ids are all lowercase (```HTML would
  // silently normalize to "text" downstream, losing BOTH highlighting and the html embed).
  return value?.trim().split(/\s+/, 1)[0]?.toLowerCase() || undefined
}

function novaClaw(raw: string) {
  const newline = raw.indexOf("\n")
  return newline < 0 ? "" : raw.slice(newline + 1)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function closesFence(raw: string, suffix: string) {
  const mark = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1]
  if (!mark) return suffix.includes("```") || suffix.includes("~~~")
  return `${raw.slice(-(mark.length - 1))}${suffix}`.includes(mark)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

// Cheap gate before paying for a lexer pass on every historical message: only texts that
// even mention an html-tagged fence opener are candidates for live-embed splitting.
function mentionsHtmlFence(text: string) {
  return /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*html\b/i.test(text)
}

// Splits ONLY closed top-level html fences out of a static message; everything else merges
// back into "full" blocks so the marked/shiki pipeline stays byte-for-byte unchanged for
// them. Static renders normally keep the whole message as one marked-rendered block, but
// that pipeline sanitizes through DOMPurify (which strips <script>), so html fences must be
// carved out as worker-rendered code blocks that still carry the raw body for the iframe.
// Unclosed trailing fences stay merged: no fence close, no embed — marked renders them as
// plain code exactly like before.
function splitHtmlFences(text: string): Block[] {
  const tokens = marked.lexer(text)
  const result: Block[] = []
  let pending = ""
  for (const token of tokens) {
    if (token.type === "code") {
      const code = token as Tokens.Code
      if (htmlEmbedLanguage(language(code.lang)) && !open(code.raw)) {
        if (pending) result.push({ raw: pending, src: pending, mode: "full" })
        pending = ""
        result.push({ raw: code.raw, src: code.text, mode: "code", language: language(code.lang), complete: true })
        continue
      }
    }
    pending += token.raw
  }
  if (pending) result.push({ raw: pending, src: pending, mode: "full" })
  if (result.length === 0) return [{ raw: text, src: text, mode: "full" }]
  return result
}

export function stream(text: string, live: boolean): Block[] {
  if (!live) {
    // Reference definitions must stay in one document for links to resolve, so those
    // messages keep the single-block behavior (html fences degrade to highlighted code).
    if (mentionsHtmlFence(text) && !refs(text)) return splitHtmlFences(text)
    return [{ raw: text, src: text, mode: "full" }] satisfies Block[]
  }
  if (refs(text)) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]
  const last = tokens[tail]
  if (!last) return [{ raw: text, src: heal(text), mode: "live" }] satisfies Block[]

  const result: Block[] = []
  for (let index = 0; index < tail; index++) {
    const token = tokens[index]
    if (!token || token.type === "space") continue
    let raw = token.raw
    while (tokens[index + 1]?.type === "space" && index + 1 < tail) raw += tokens[++index]!.raw
    if (token.type === "code") {
      const code = token as Tokens.Code
      result.push({ raw, src: code.text, mode: "code", language: language(code.lang), complete: true })
      continue
    }
    result.push({ raw, src: raw, mode: "full" })
  }

  const raw = tokens
    .slice(tail)
    .map((token) => token.raw)
    .join("")
  if (last.type !== "code") return [...result, { raw, src: heal(raw), mode: "live" }]

  const code = last as Tokens.Code
  if (!open(code.raw))
    return [...result, { raw, src: code.text, mode: "code", language: language(code.lang), complete: true }]
  return [...result, { raw, src: novaClaw(code.raw), mode: "code", language: language(code.lang) }]
}

export function canReusePendingBlock(current: Pick<Block, "mode" | "raw"> | undefined, next: Block) {
  if (!current || current.mode !== next.mode) return false
  if (next.mode === "code") return next.raw.startsWith(current.raw)
  return current.raw === next.raw
}

export function project(previous: Projection | undefined, text: string, live: boolean): Projection {
  if (!live || !previous || !text.startsWith(previous.text)) return { text, blocks: stream(text, live) }
  const tail = previous.blocks.at(-1)
  const suffix = text.slice(previous.text.length)
  if (!suffix || tail?.mode !== "code" || tail.complete || closesFence(tail.raw, suffix))
    return { text, blocks: stream(text, live) }
  return {
    text,
    blocks: [
      ...previous.blocks.slice(0, -1),
      {
        ...tail,
        raw: tail.raw + suffix,
        src: tail.src + suffix,
      },
    ],
  }
}
