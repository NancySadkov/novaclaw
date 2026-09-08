export * as PostfixPrompt from "./postfix-prompt"

import { LLM, Message, type LLMRequest } from "@novaclaw/llm"

/**
 * Turn an existing provider request into a derived pass without moving its evidence.
 *
 * The original system prompt, tool catalogue, and conversation remain byte-for-byte at the front;
 * only the operation to perform is appended. That is both the provider prefix-cache invariant and
 * the natural reading order for a sequential model: evidence first, current instruction last.
 */
export const append = (
  prefix: LLMRequest,
  instruction: string,
  options: { readonly maxTokens?: number; readonly disableTools?: boolean } = {},
): LLMRequest =>
  LLM.request({
    ...LLM.requestInput(prefix),
    messages: [...prefix.messages, Message.user(instruction)],
    ...(options.maxTokens === undefined ? {} : { generation: { ...prefix.generation, maxTokens: options.maxTokens } }),
    // Keep the tool definitions: chat templates commonly render them before the transcript, so
    // removing them would invalidate the very prefix this helper exists to preserve. Tool choice is
    // sampling policy, not evidence, and prevents a presentation/summary pass from acting.
    ...(options.disableTools ? { callableTools: [], toolChoice: "none" as const } : {}),
  })
