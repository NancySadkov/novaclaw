export * as ReasoningEffortFloor from "./reasoning-effort"

import type { ReasoningEffort } from "@novaclaw/llm"

/**
 * The lowest reasoning effort an ENDPOINT MODEL will accept, once it has told us.
 *
 * `ProviderDispatch.withoutReasoning` asks for "no thinking" with the provider-neutral `"none"`.
 * A hosted gateway answered `muse-spark-1.3-contributor` with
 * `reasoning_effort 'none' is not supported ... Supported values: [minimal, low, medium, high, xhigh, max]`
 * (measured 2026-09-22), so every zero-budget turn and every compaction failed identically.
 * `provider-error.ts` reads the floor out of that refusal; this remembers it.
 *
 * ## Why in-process AND persisted
 *
 * Within one turn the runner learns, re-resolves and rebuilds — and every rebuild reads
 * `Model.compatibility.reasoningEffortFloor`, so the learned value must be visible to the resolver
 * IMMEDIATELY, before any store round trip. That is this map. Across turns the map is gone (each
 * turn drains in a fresh worker), which is why `SessionRunnerModel.rememberReasoningEffortFloor`
 * writes the durable row beside it.
 *
 * Model-keyed, not endpoint-keyed: the refusal names the model, and one gateway can host models
 * whose effort enums differ.
 */
const learned = new Map<string, ReasoningEffort>()

export const key = (reference: { readonly providerID: string; readonly id: string }): string =>
  `${reference.providerID}/${reference.id}`

/** This process's answer for the model, or `undefined` when it has not been told yet. */
export const floorFor = (reference: {
  readonly providerID: string
  readonly id: string
}): ReasoningEffort | undefined => learned.get(key(reference))

/** True once this process has learned the floor, so a repeat refusal is a different fault. */
export const isLearned = (reference: { readonly providerID: string; readonly id: string }): boolean =>
  learned.has(key(reference))

export const remember = (
  reference: { readonly providerID: string; readonly id: string },
  floor: ReasoningEffort,
): void => {
  learned.set(key(reference), floor)
}

/** Test seam: module state must not leak between cases. */
export const clear = (): void => learned.clear()
