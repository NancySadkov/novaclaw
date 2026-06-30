// V2-native sessions reuse message-scoped stream ids ("text-0"/"reasoning-0") as
// part ids, so a part id is only unique WITHIN its message — across messages, every
// first text part is "text-0". Per-session bookkeeping (part_text_accum_delta,
// deltaBases) must therefore be keyed by (messageID, partID), never partID alone, or
// the streaming delta of the active turn's "text-0" bleeds into every prior message's
// "text-0" part (the "response replicated under each user message" ghost). \x1f (unit
// separator) cannot appear in an id, so the compound key is unambiguous.
export function accumDeltaKey(messageID: string, partID: string): string {
  return `${messageID}\x1f${partID}`
}

export function readPartText(
  accum: Record<string, string> | undefined,
  messageID: string,
  part: { id: string; text?: string },
): string {
  return (accum?.[accumDeltaKey(messageID, part.id)] ?? part.text ?? "").trim()
}
