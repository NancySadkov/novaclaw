export * as SessionToolContent from "./tool-content"

import type { SessionMessage } from "./message"

/**
 * The durable transcript representation of a completed tool result is structured `content`, not
 * the provider's transient `output` string. Every consumer that explains past tool work must read
 * this seam or it will silently turn real evidence into an empty result.
 */
export const serialize = (content: SessionMessage.ToolStateCompleted["content"]): string =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

/** Text suitable for appraisal and compact audit prompts, including a durable tool error. */
export const stateText = (state: SessionMessage.ToolState): string | undefined => {
  if (state.status === "completed") return serialize(state.content)
  if (state.status === "error") return state.error.message
  return undefined
}
