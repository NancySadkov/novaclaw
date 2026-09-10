import type { SessionMessage, SessionMessageAssistant, SessionV2Info as Session } from "@novaclaw/sdk/v2/client"

type Provider = {
  id: string
  name?: string
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

export type ModelLookup = (providerID: string, modelID: string) => Model | undefined

type Context = {
  message: SessionMessageAssistant
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  /** The last turn's full token footprint (prompt + generation) — what the next request carries. */
  total: number
  usage: number | null
}

const tokenTotal = (msg: SessionMessageAssistant) => {
  const t = msg.tokens
  return t ? t.input + t.output + t.reasoning + t.cache.read + t.cache.write : 0
}

/**
 * Context pressure is one request, not the sum of every provider phase used to produce the reply.
 * ReasoningBudget deliberately aggregates phase usage for billing, so `message.tokens` can exceed
 * the model window several times over. The prompt anchor is the provider's exact count for the
 * anchorable request; the packer's estimate is the honest fallback when the wire reported none.
 */
const contextInput = (msg: SessionMessageAssistant) =>
  msg.context?.promptAnchor?.reportedTokens ??
  msg.context?.estimatedTokens ??
  (msg.tokens ? msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write : 0)

const contextTotal = (msg: SessionMessageAssistant) => {
  const input = contextInput(msg)
  const tokens = msg.tokens
  return input + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
}

const lastAssistantWithContext = (messages: readonly SessionMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== "assistant") continue
    if (tokenTotal(msg) <= 0 && (msg.context?.estimatedTokens ?? 0) <= 0) continue
    return msg
  }
}

const build = (
  messages: readonly SessionMessage[] = [],
  providers: Provider[] = [],
  model_: ModelLookup = () => undefined,
): Context | undefined => {
  const message = lastAssistantWithContext(messages)
  if (!message) return undefined

  const provider = providers.find((item) => item.id === message.model.providerID)
  const model = model_(message.model.providerID, message.model.id)
  const limit = message.context?.window ?? model?.limit.context
  const input = contextInput(message)
  const total = contextTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.model.providerID,
    modelLabel: model?.name ?? message.model.id,
    limit,
    input,
    total,
    usage: limit ? Math.round((total / limit) * 100) : null,
  }
}

export function getSessionContext(
  messages: readonly SessionMessage[] = [],
  providers: Provider[] = [],
  model: ModelLookup = () => undefined,
) {
  return build(messages, providers, model)
}

export function getSessionTokenTotal(tokens: Session["tokens"] | undefined) {
  if (!tokens) return undefined
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}
