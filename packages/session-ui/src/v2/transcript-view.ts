const isSetupMarker = (message: { type: string }) =>
  message.type === "agent-switched" || message.type === "model-switched"

/**
 * Hide the initial agent/model selection records while retaining switches that happen during a
 * conversation. An all-marker list is empty, not pass-through: that is the state left when the
 * first visible prompt is staged for revert.
 */
export function selectTranscriptMessages<T extends { type: string }>(messages: readonly T[]): readonly T[] {
  const firstReal = messages.findIndex((message) => !isSetupMarker(message))
  if (firstReal < 0) return []
  if (firstReal === 0) return messages
  return messages.slice(firstReal)
}
