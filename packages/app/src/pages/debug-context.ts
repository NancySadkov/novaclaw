import type { SessionMessage, SessionMessageAssistant, SessionMessageContext } from "@novaclaw/sdk/v2/client"

export type ContextTurn = SessionMessageAssistant & { context: SessionMessageContext }

export const contextTurns = (messages: ReadonlyArray<SessionMessage>, limit = 8): ContextTurn[] =>
  messages
    .filter((message): message is ContextTurn => message.type === "assistant" && message.context !== undefined)
    .sort((a, b) => b.time.created - a.time.created)
    .slice(0, Math.max(0, limit))

export const formatContextTokens = (tokens: number): string => {
  if (tokens < 1_000) return `${Math.round(tokens)}`
  const value = tokens / 1_000
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}k`
}

const targetLabel = (target: string | undefined): string => (target === undefined ? "" : ` for “${target}”`)

export const formatContextFinding = (finding: SessionMessageContext["findings"][number]): string => {
  if (finding.kind === "duplicate-tool-output") {
    const subject = `${finding.tool} output${targetLabel(finding.target)}`
    const repeated = `about ${formatContextTokens(finding.repeatedTokens)} repeated tokens`
    return finding.elided
      ? `${subject} appeared ${finding.occurrences} times; NovaClaw folded the repeats, saving ${repeated}.`
      : `${subject} appears ${finding.occurrences} times and contains ${repeated}.`
  }
  if (finding.kind === "category-budget") {
    const label =
      finding.category === "tool_output"
        ? "Tool output"
        : finding.category === "retrieval"
          ? "Knowledge retrieval"
          : finding.category[0]!.toUpperCase() + finding.category.slice(1)
    const before = formatContextTokens(finding.beforeTokens)
    const after = formatContextTokens(finding.afterTokens)
    const limit = formatContextTokens(finding.limitTokens)
    return finding.protected
      ? `${label} used about ${after} tokens, above its ${limit}-token share; the newest evidence, system instructions, or original task was kept on purpose.`
      : `${label} was reduced from about ${before} to ${after} tokens to stay inside its ${limit}-token share.`
  }
  return `${finding.tool} output${targetLabel(finding.target)} occupies ${finding.percent}% of this turn’s context (about ${formatContextTokens(finding.tokens)} tokens).`
}
