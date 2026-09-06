/** Chats with unseen output, deduplicated for badges and navigation. */
export function attentionSessionIds(input: { unseen: readonly string[] }): string[] {
  return [...new Set(input.unseen)]
}
