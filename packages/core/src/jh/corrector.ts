export * as JhCorrector from "./corrector"

// jh — the fresh-context Corrector (jh.md §5 law 6, §6): on a failed verify it sees ONLY {goal, failing
// artifact, exact error} — never the messy failure transcript a small model would drown in (§10: weak
// models can't self-critique; correction is external + fresh-context, structurally). The function
// signature makes transcript leakage impossible. Pure: a prompt builder + a last-fence parser.

import type { JhExpander } from "./expander"

/** Extract the LAST fenced block's content (any language tag), tolerating an unterminated final fence. */
function lastFence(text: string): string | undefined {
  const parts = text.split("```")
  if (parts.length < 2) return undefined
  let last: string | undefined
  for (let i = 1; i < parts.length; i += 2) last = parts[i]
  if (last === undefined) return undefined
  // Strip a leading language tag line ("c\n", "json\n", or a bare "\n") and one trailing newline.
  return last.replace(/^[ \t]*[a-zA-Z0-9_+-]*[ \t]*\r?\n/, "").replace(/\r?\n$/, "")
}

export function correctorPrompt(input: {
  readonly goal: string
  readonly artifactID: string
  readonly artifactContent: string
  readonly error: string
}): JhExpander.PromptPair {
  const system = [
    "You are the repair component of a deterministic execution harness.",
    "You are given a goal, ONE artifact that failed its check, and the exact error.",
    "Return the smallest fix: the COMPLETE corrected content of the artifact, in ONE fenced code block, and nothing else.",
    "Do not explain, do not restate the error — output only the fixed content in a single ``` fence.",
  ].join("\n")
  const user = [
    `# Goal`,
    input.goal,
    ``,
    `# Failing artifact: ${input.artifactID}`,
    "```",
    input.artifactContent,
    "```",
    ``,
    `# Exact error`,
    input.error,
    ``,
    "Output the complete corrected content in one fenced block.",
  ].join("\n")
  return { system, user }
}

export function parseCorrection(text: string): { readonly ok: true; readonly content: string } | { readonly ok: false; readonly issue: string } {
  const content = lastFence(text)
  if (content === undefined) return { ok: false, issue: "no fenced code block found in the correction" }
  return { ok: true, content }
}
