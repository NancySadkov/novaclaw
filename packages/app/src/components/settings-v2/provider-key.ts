/**
 * What to write for a provider's API key — the rule, as a pure function.
 *
 * 🔴 The key rides the PROVIDER, at `providers.<id>.request.body.apiKey`, which is the one place V2
 * model resolution reads it (`session/runner/model.ts`). It is not a per-model field, so every model
 * from a provider shares it.
 *
 * Three behaviours, each of which fails in a way somebody would have to debug:
 *
 *   1. **Unchanged means DON'T REWRITE.** Returning a fresh object every save would rewrite the
 *      provider layer on every unrelated edit — a config write per keystroke-session, and, because a
 *      config write disposes instances, a good deal more than a config write.
 *   2. **Empty means CLEAR, and clearing needs a VALUE.** The config store patch-merges, so omitting
 *      `apiKey` PRESERVES it — "delete my key" would silently do nothing. It is written as `""`.
 *   3. **Other body fields survive.** `request.body` also carries provider-specific request overlay
 *      (sampling defaults and the like); replacing the body wholesale would drop them.
 */

export interface ProviderRequest {
  readonly body?: Record<string, unknown>
  readonly [key: string]: unknown
}

export const mergeProviderKey = (input: {
  /** The provider's existing `request`, if it has one. */
  readonly request: ProviderRequest | undefined
  /** The key currently stored — what the field was seeded with. */
  readonly stored: string
  /** What the user left in the field, already trimmed. */
  readonly next: string
}): ProviderRequest | undefined => {
  if (input.next === input.stored) return input.request
  return { ...(input.request ?? {}), body: { ...(input.request?.body ?? {}), apiKey: input.next } }
}
