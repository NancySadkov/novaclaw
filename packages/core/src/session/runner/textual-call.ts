export * as TextualCall from "./textual-call"

// The silent-no-op guard (notes/osint/silent-noop-bug.md, found 2026-07-25).
//
// `isEmptyAssistantTurn` already recovers a turn with NO text and NO tool call. The hole is the turn that
// produced plenty of text and no tool call, because the runner then — correctly by its own rules — settles
// it as a finished answer. Measured live on the client's real task: three runs where the model planned
// well, wrote a tool call as MARKDOWN (a ```bash fence, an invented adhoc-tool JSON, a literal <thinking>
// block repeated verbatim), and the run reported success having done nothing. For an unattended scheduled
// agent that is the worst failure mode there is: indistinguishable from a good run.
//
// ⚠️ **We detect, then STEER — we never execute what the model wrote.** That asymmetry is the whole design.
// A ```bash fence is ordinary assistant output ("run this command…"); auto-running one whenever a turn ends
// would turn documentation into execution. A missed turn costs a retry; an unintended shell command costs a
// machine. Because the response is only ever a nudge, detection can afford to be GENEROUS — a false
// positive costs one wasted steer, and the message gives the model an explicit way to say "that was just an
// example, I'm done".
//
// Pure + unit-tested; the runner supplies the text and the allowed tool names.

export type Tell = "fenced-tool" | "fenced-json-call" | "tool-tag" | "repeated-block"

export interface TextualCall {
  readonly tell: Tell
  /** Short, loggable description of what tripped it — never the whole turn. */
  readonly detail: string
}

/** A repeated block shorter than this is ordinary prose (a heading, a stock phrase), not a loop. */
export const REPEAT_MIN_CHARS = 180

const fences = (text: string): Array<{ lang: string; body: string }> => {
  const out: Array<{ lang: string; body: string }> = []
  const block = /```([A-Za-z0-9_-]*)\s*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = block.exec(text))) out.push({ lang: (match[1] ?? "").toLowerCase(), body: match[2] ?? "" })
  return out
}

/** The largest block of text that appears at least twice, verbatim. */
const repeatedBlock = (text: string): string | undefined => {
  // Compare on paragraphs: a degenerate loop repeats whole chunks, and this stays O(n) in practice.
  const seen = new Set<string>()
  for (const raw of text.split(/\n\s*\n/)) {
    const para = raw.trim()
    if (para.length < REPEAT_MIN_CHARS) continue
    if (seen.has(para)) return para
    seen.add(para)
  }
  return undefined
}

/**
 * Does this no-tool-call turn look like the model MEANT to act? Returns the tell, or `undefined` when the
 * turn reads like a genuine answer.
 *
 * Order matters only for reporting — any single tell is enough to steer.
 */
export const detect = (text: string, toolNames: ReadonlyArray<string>): TextualCall | undefined => {
  if (!text.trim()) return undefined
  const allowed = new Set(toolNames.map((name) => name.toLowerCase()))

  for (const fence of fences(text)) {
    // ```bash / ```websearch … — a fence whose LANGUAGE TAG is one of our tools. The model is very
    // likely showing the call it wanted to make. (Not executed — see the header.)
    if (fence.lang && allowed.has(fence.lang) && fence.body.trim())
      return { tell: "fenced-tool", detail: `fenced \`${fence.lang}\` block` }
    // ```json {"name": "...", ...} — an explicit call object. The name need NOT resolve: inventing a
    // tool is still an attempt to act, and is exactly what we want to correct.
    if (fence.lang === "json" || fence.lang === "") {
      const body = fence.body.trim()
      if (body.startsWith("{") && /"name"\s*:/.test(body)) {
        const named = /"name"\s*:\s*"([^"]{1,64})"/.exec(body)
        return { tell: "fenced-json-call", detail: `json call object${named ? ` for "${named[1]}"` : ""}` }
      }
    }
  }

  // Literal machinery in the CONTENT channel: the model wrote the tags instead of using the channel.
  const tag = /<\/?(tool_call|thinking|think|function_call)\b/i.exec(text)
  if (tag) return { tell: "tool-tag", detail: `literal <${tag[1]}> tag in the reply` }

  // A verbatim-repeated paragraph is the degenerate-loop tell — the same pathology as a runaway digit
  // loop, but in the content channel where the reasoning budget cannot see it.
  const repeat = repeatedBlock(text)
  if (repeat) return { tell: "repeated-block", detail: `repeated ${repeat.length}-char block` }

  return undefined
}

/** The corrective steer. Names the mistake, demands a real call, and leaves an honest way out. */
export const recoveryMessage = (found: TextualCall): string =>
  `Your last turn ended without calling any tool, but it contained what looks like a tool call written as ` +
  `text (${found.detail}). Writing a call as markdown or as a tag does NOT run it — nothing happened, and ` +
  `the task is still untouched.\n\n` +
  `Issue the call properly now, using the real tool-call mechanism, one step at a time. Use only the tools ` +
  `you actually have; do not invent a tool or wrap a call in a code fence.\n\n` +
  `If that block was only an illustration and the work really is finished, say so explicitly and give your ` +
  `final summary instead.`
