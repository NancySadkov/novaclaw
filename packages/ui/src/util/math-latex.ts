// MATH IN A CHAT (owner, 2026-08-23: *"STEM is a typical usecase for agentic AI, and most models are
// trained to generate nice tex/latex, but these can still be malformed, so we have to detect and if
// possible fix them, before rendering, but without confusing normal text for them"*).
//
// Three problems, and they pull in opposite directions:
//
// 1. **Detection must be CONSERVATIVE.** `$` is a currency symbol far more often than it is a math
//    delimiter. "It costs $5 and the other is $10" contains two dollar signs and no mathematics, and
//    the naive inline rule renders "5 and the other is " as a formula. A chat that turns prices into
//    italic serif is worse than one that renders no math at all, because the failure is silent and
//    it happens to text the user wrote themselves.
// 2. **Repair must be CHEAP AND VERIFIED.** Small models emit LaTeX with a missing brace, a `\left`
//    with no `\right`, a smart quote where an apostrophe belongs, or a raw `%` that comments out the
//    rest of the line. Each is mechanical to fix. What is NOT acceptable is guessing: every repair
//    is applied and then RE-CHECKED against the real KaTeX parser, and anything that still does not
//    parse is rendered as the plain text the model wrote. **We never show a red error box.**
// 3. **Non-`$` delimiters exist and are common.** Models trained on LaTeX emit `\(…\)`, `\[…\]`,
//    and `\begin{equation}…\end{equation}` at least as often as `$…$`. Supporting only `$` means the
//    STEM answer that took the most effort to produce is the one that renders as gibberish.
//
// Everything here is PURE except `render`, which takes the KaTeX entry point as an argument — so the
// detector and the repairs are testable without a DOM and without loading a 300 KB parser.

/** One detected math span in a source string. */
export interface MathSpan {
  /** Index of the first character of the whole span, delimiters included. */
  readonly start: number
  /** Index one past the last character of the whole span. */
  readonly end: number
  /** The LaTeX between the delimiters, untrimmed. */
  readonly body: string
  /** Display (block) math rather than inline. */
  readonly display: boolean
}

/**
 * Characters that make a `$…$` span plausible as MATHEMATICS rather than as two prices.
 *
 * ⚠️ This is the whole false-positive defence, so it is deliberately a positive test: a span must
 * contain at least one thing that only occurs in maths. A run of ordinary words between two dollar
 * signs fails it, which is the desired answer for "costs $5 and $10 more".
 */
const MATHY = /[\\^_{}=<>+/]|\\[a-zA-Z]+|\b[a-zA-Z]\s*[\^_]|\d\s*[×·]/

/** A `$…$` span that is really a price range: digits, separators and currency words only. */
const PRICEY = /^\s*\d[\d,. ]*\s*(?:and|to|or|-|–|—)?[\d,. ]*\s*$/i

/**
 * Would this text, between two `$`, be mathematics?
 *
 * The rules, in the order they fire:
 *  - **Empty or whitespace-only** — no.
 *  - **Spans a blank line** — no. Inline math does not contain paragraph breaks; a `$` on one
 *    paragraph and a `$` three paragraphs later is two currency symbols.
 *  - **Looks like a price** — no, even if a `-` sneaks in ("$5-$10").
 *  - **Starts or ends with whitespace AND has no LaTeX command** — no. Real inline maths is written
 *    tight against its delimiters; `$ 5 and 10 $` is prose that happens to be bracketed.
 *  - **Contains a mathematical character or command** — yes.
 *  - Otherwise — no. A bare `$word$` is not worth the risk.
 */
export function looksLikeInlineMath(body: string): boolean {
  if (body.trim() === "") return false
  if (/\n\s*\n/.test(body)) return false
  if (PRICEY.test(body)) return false
  const hasCommand = /\\[a-zA-Z]+/.test(body)
  if (!hasCommand && /^\s|\s$/.test(body)) return false
  return MATHY.test(body)
}

/**
 * Find every math span in `source`, skipping fenced and inline code.
 *
 * ⚠️ Code is skipped by SCANNING, not by a regex over the whole string: a fence can contain
 * anything, including unbalanced `$`, and a `[\s\S]*?` pattern across a document with several fences
 * pairs the wrong ones. The scanner walks once, left to right, and always knows whether it is inside
 * a fence, inline code, or prose.
 *
 * Display forms recognised: `$$…$$`, `\[…\]`, and `\begin{env}…\end{env}` for the standard AMS
 * environments. Inline: `$…$` (guarded by {@link looksLikeInlineMath}) and `\(…\)` (never guarded —
 * nothing writes `\(` by accident).
 */
export function findMathSpans(source: string): MathSpan[] {
  const spans: MathSpan[] = []
  let i = 0
  const n = source.length
  const atLineStart = (index: number) => index === 0 || source[index - 1] === "\n"

  while (i < n) {
    const ch = source[i]!

    // ── fenced code ────────────────────────────────────────────────────────────────
    if ((ch === "`" || ch === "~") && atLineStart(i) && source.startsWith(ch.repeat(3), i)) {
      let fence = 0
      while (source[i + fence] === ch) fence++
      const marker = ch.repeat(fence)
      let close = i + fence
      // The closing fence must be at least as long and must start a line.
      for (;;) {
        close = source.indexOf(marker, close)
        if (close === -1) return spans // unterminated fence: everything after it is code
        if (atLineStart(close)) break
        close += marker.length
      }
      i = close + marker.length
      continue
    }

    // ── inline code ────────────────────────────────────────────────────────────────
    if (ch === "`") {
      let ticks = 0
      while (source[i + ticks] === "`") ticks++
      const marker = "`".repeat(ticks)
      const close = source.indexOf(marker, i + ticks)
      if (close === -1) {
        i += ticks
        continue
      }
      i = close + ticks
      continue
    }

    // ── an escaped delimiter is not a delimiter ────────────────────────────────────
    if (ch === "\\") {
      const next = source[i + 1]
      if (next === "$") {
        i += 2
        continue
      }
      if (next === "[") {
        const close = source.indexOf("\\]", i + 2)
        if (close !== -1) {
          spans.push({ start: i, end: close + 2, body: source.slice(i + 2, close), display: true })
          i = close + 2
          continue
        }
      }
      if (next === "(") {
        const close = source.indexOf("\\)", i + 2)
        if (close !== -1) {
          spans.push({ start: i, end: close + 2, body: source.slice(i + 2, close), display: false })
          i = close + 2
          continue
        }
      }
      if (source.startsWith("\\begin{", i)) {
        const nameEnd = source.indexOf("}", i + 7)
        if (nameEnd !== -1) {
          const env = source.slice(i + 7, nameEnd)
          if (DISPLAY_ENVIRONMENTS.has(env.replace(/\*$/, ""))) {
            const closer = `\\end{${env}}`
            const close = source.indexOf(closer, nameEnd)
            if (close !== -1) {
              // The environment is kept WHOLE in the body — KaTeX parses `\begin{aligned}…` itself,
              // and stripping it would throw away the alignment the model asked for.
              const end = close + closer.length
              spans.push({ start: i, end, body: source.slice(i, end), display: true })
              i = end
              continue
            }
          }
        }
      }
      i += 2
      continue
    }

    // ── $$ … $$ ────────────────────────────────────────────────────────────────────
    if (ch === "$" && source[i + 1] === "$") {
      const close = source.indexOf("$$", i + 2)
      if (close !== -1) {
        spans.push({ start: i, end: close + 2, body: source.slice(i + 2, close), display: true })
        i = close + 2
        continue
      }
      i += 2
      continue
    }

    // ── $ … $ ──────────────────────────────────────────────────────────────────────
    if (ch === "$") {
      let close = i + 1
      for (;;) {
        close = source.indexOf("$", close)
        if (close === -1) break
        if (source[close - 1] === "\\") {
          close += 1
          continue
        }
        break
      }
      if (close === -1) {
        i += 1
        continue
      }
      const body = source.slice(i + 1, close)
      if (looksLikeInlineMath(body)) {
        spans.push({ start: i, end: close + 1, body, display: false })
        i = close + 1
        continue
      }
      // Not maths. Move past the OPENING dollar only — the closing one may open a real span with
      // whatever follows it, and consuming it here would hide that.
      i += 1
      continue
    }

    i += 1
  }
  return spans
}

/** Environments KaTeX understands and that models actually emit. */
const DISPLAY_ENVIRONMENTS = new Set([
  "equation",
  "align",
  "aligned",
  "alignat",
  "gather",
  "gathered",
  "split",
  "multline",
  "cases",
  "array",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
])

/**
 * Unicode a model writes where LaTeX wants a command. All of these round-trip to the identical
 * glyph, so the substitution changes nothing a reader can see — it only makes the string parse.
 */
const UNICODE_TO_TEX: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
  [/−/g, "-"],
  [/×/g, "\\times "],
  [/÷/g, "\\div "],
  [/≤/g, "\\leq "],
  [/≥/g, "\\geq "],
  [/≠/g, "\\neq "],
  [/≈/g, "\\approx "],
  [/±/g, "\\pm "],
  [/∞/g, "\\infty "],
  [/→/g, "\\to "],
  [/⇒/g, "\\Rightarrow "],
  [/∑/g, "\\sum "],
  [/∏/g, "\\prod "],
  [/∫/g, "\\int "],
  [/√/g, "\\sqrt "],
  [/…/g, "\\ldots "],
  [/·/g, "\\cdot "],
]

/** Count unescaped occurrences of a single character. */
function countUnescaped(text: string, char: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++
      continue
    }
    if (text[i] === char) count++
  }
  return count
}

/**
 * Repair the malformations small models actually produce, in escalating order.
 *
 * 🔴 **Every repair here is SAFE-BY-CONSTRUCTION or verified by the caller.** `repairLatex` returns
 * a LIST of candidates, most-conservative first, and {@link render} takes the first one the real
 * parser accepts. Nothing is guessed into the output: if none parses, the model's own text is shown
 * verbatim. That is the difference between "we fixed a typo" and "we invented a formula".
 */
export function repairLatex(body: string): string[] {
  const candidates: string[] = []
  const push = (value: string) => {
    const trimmed = value.trim()
    if (trimmed !== "" && !candidates.includes(trimmed)) candidates.push(trimmed)
  }

  // 0. Unicode operators the model typed instead of commands. Applied UNCONDITIONALLY rather than
  //    offered as a fallback candidate, because every entry round-trips to the identical glyph — it
  //    is a normalisation, not a guess. It also has to be unconditional to be useful: KaTeX accepts
  //    a stray `’` in its default `warn` strictness, so a candidate behind it would never be
  //    reached, and the reader would get a console warning and an unknown-character box.
  let step = body
  for (const [pattern, replacement] of UNICODE_TO_TEX) step = step.replace(pattern, replacement)
  push(step)

  // 1. A raw `%` comments out the rest of the line in TeX, which silently eats the formula.
  //    A model writing "50\%" means the sign; one writing "50%" almost always does too.
  step = step.replace(/(^|[^\\])%/g, "$1\\%")
  push(step)

  // 2. `\left` without its `\right` (and the reverse). KaTeX rejects the pair outright.
  const lefts = (step.match(/\\left(?![a-zA-Z])/g) ?? []).length
  const rights = (step.match(/\\right(?![a-zA-Z])/g) ?? []).length
  if (lefts !== rights) {
    // Dropping BOTH sizing commands keeps every delimiter the model wrote and only loses the
    // automatic sizing — a smaller loss than losing the formula.
    push(step.replace(/\\left(?![a-zA-Z])/g, "").replace(/\\right(?![a-zA-Z])/g, ""))
    step = step.replace(/\\left(?![a-zA-Z])/g, "").replace(/\\right(?![a-zA-Z])/g, "")
  }

  // 3. Unbalanced braces — the single commonest truncation in a streamed formula.
  const open = countUnescaped(step, "{")
  const close = countUnescaped(step, "}")
  if (open > close) push(step + "}".repeat(open - close))
  else if (close > open) push("{".repeat(close - open) + step)

  return candidates
}

/** What {@link render} produced. */
export type MathRender =
  | { readonly ok: true; readonly html: string; readonly repaired: boolean }
  /** Nothing parsed. The caller must show `text` as ordinary prose — never an error box. */
  | { readonly ok: false; readonly text: string }

/** The one KaTeX call this module needs, injected so the module stays testable and DOM-free. */
export type KatexRenderer = (tex: string, options: { displayMode: boolean; throwOnError: boolean }) => string

/**
 * Render one math span: try it as written, then each repair, and give up honestly.
 *
 * ⚠️ `throwOnError: true` is deliberate and is the whole mechanism. With `false`, KaTeX renders the
 * offending command in red and reports success — so a "repair" that made nothing better would look
 * exactly like one that worked, and the escalation below could never terminate on the right rung.
 * The parser is the verifier; that only works if it is allowed to say no.
 */
export function render(body: string, options: { display: boolean; katex: KatexRenderer }): MathRender {
  const candidates = repairLatex(body)
  for (let index = 0; index < candidates.length; index++) {
    try {
      const html = candidates[index]!
      return {
        ok: true,
        html: options.katex(html, { displayMode: options.display, throwOnError: true }),
        repaired: index > 0,
      }
    } catch {
      // Next rung.
    }
  }
  return { ok: false, text: body }
}
