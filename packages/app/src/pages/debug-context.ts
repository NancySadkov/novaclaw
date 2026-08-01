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
  return `${finding.tool} output${targetLabel(finding.target)} occupies ${finding.percent}% of this turn’s context (about ${formatContextTokens(finding.tokens)} tokens).`
}
