import type { SessionMessage, SessionMessageAssistant, Session } from "@novaclaw/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: SessionMessageAssistant
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  usage: number | null
}

const tokenTotal = (msg: SessionMessageAssistant) => {
  const t = msg.tokens
  return t ? t.input + t.output + t.reasoning + t.cache.read + t.cache.write : 0
}

const lastAssistantWithTokens = (messages: readonly SessionMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

const build = (messages: readonly SessionMessage[] = [], providers: Provider[] = []): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const provider = providers.find((item) => item.id === message.model.providerID)
  const model = provider?.models[message.model.id]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.model.providerID,
    modelLabel: model?.name ?? message.model.id,
    limit,
    input: message.tokens?.input ?? 0,
    usage: limit ? Math.round((total / limit) * 100) : null,
  }
}

export function getSessionContext(messages: readonly SessionMessage[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}

export function getSessionTokenTotal(tokens: Session["tokens"] | undefined) {
  if (!tokens) return undefined
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}
