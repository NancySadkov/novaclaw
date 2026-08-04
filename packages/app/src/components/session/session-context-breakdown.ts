import type { SessionMessage, SessionMessageAssistant } from "@novaclaw/sdk/v2/client"
import { Token } from "@novaclaw/core/util/token"

export type SessionContextBreakdownKey = "system" | "user" | "assistant" | "tool" | "other"

export type SessionContextBreakdownSegment = {
  key: SessionContextBreakdownKey
  tokens: number
  width: number
  percent: number
}

type AssistantContent = SessionMessageAssistant["content"][number]

// The bar is aggregated from per-category CHAR counts (not text), then scaled to the real input
// token total below — so the shared flat char→token estimate is the right tool here.
const estimateTokens = (chars: number) => Token.estimateFromChars(chars)
const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10

// A native user message keeps the full prompt in `text` (inline @-mentions included; `files`/`agents`
// carry only their source positions), so `text.length` captures the turn without double-counting.
const charsFromUser = (message: Extract<SessionMessage, { type: "user" }>) => message.text.length

const charsFromAssistantContent = (content: AssistantContent): { assistant: number; tool: number } => {
  if (content.type === "text") return { assistant: content.text.length, tool: 0 }
  if (content.type === "reasoning") return { assistant: content.text.length, tool: 0 }

  const state = content.state
  if (state.status === "pending") return { assistant: 0, tool: state.input.length }

  const input = Object.keys(state.input).length * 16
  if (state.status === "error") return { assistant: 0, tool: input + state.error.message.length }

  // running | completed — sum the text of the tool's output content (file refs carry no length here).
  const output = state.content.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 0), 0)
  return { assistant: 0, tool: input + output }
}

const build = (
  tokens: { system: number; user: number; assistant: number; tool: number; other: number },
  input: number,
) => {
  return [
    {
      key: "system",
      tokens: tokens.system,
    },
    {
      key: "user",
      tokens: tokens.user,
    },
    {
      key: "assistant",
      tokens: tokens.assistant,
    },
    {
      key: "tool",
      tokens: tokens.tool,
    },
    {
      key: "other",
      tokens: tokens.other,
    },
  ]
    .filter((x) => x.tokens > 0)
    .map((x) => ({
      key: x.key,
      tokens: x.tokens,
      width: toPercent(x.tokens, input),
      percent: toPercentLabel(x.tokens, input),
    })) as SessionContextBreakdownSegment[]
}

export function estimateSessionContextBreakdown(args: {
  messages: readonly SessionMessage[]
  input: number
  systemPrompt?: string
}) {
  if (!args.input) return []

  const counts = args.messages.reduce(
    (acc, msg) => {
      if (msg.type === "user") return { ...acc, user: acc.user + charsFromUser(msg) }
      if (msg.type !== "assistant") return acc

      const assistant = msg.content.reduce(
        (sum, content) => {
          const next = charsFromAssistantContent(content)
          return {
            assistant: sum.assistant + next.assistant,
            tool: sum.tool + next.tool,
          }
        },
        { assistant: 0, tool: 0 },
      )
      return {
        ...acc,
        assistant: acc.assistant + assistant.assistant,
        tool: acc.tool + assistant.tool,
      }
    },
    {
      system: args.systemPrompt?.length ?? 0,
      user: 0,
      assistant: 0,
      tool: 0,
    },
  )

  const tokens = {
    system: estimateTokens(counts.system),
    user: estimateTokens(counts.user),
    assistant: estimateTokens(counts.assistant),
    tool: estimateTokens(counts.tool),
  }
  const estimated = tokens.system + tokens.user + tokens.assistant + tokens.tool

  if (estimated <= args.input) {
    return build({ ...tokens, other: args.input - estimated }, args.input)
  }

  const scale = args.input / estimated
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  }
  const total = scaled.system + scaled.user + scaled.assistant + scaled.tool
  return build({ ...scaled, other: Math.max(0, args.input - total) }, args.input)
}
