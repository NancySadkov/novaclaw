export * as RepetitionFloor from "./repetition-floor"

import { produce } from "immer"
import type { ModelV2 } from "../../model"
import { ProviderCapability } from "../../provider-capability"
import { endpointKey } from "./endpoint"

// Unattended-safety floor for local / openai-compatible models. Without a repetition penalty most
// small models LOOP, which is fatal for unattended runs — so default `repetition_penalty` to a
// light 1.05 (owner 2026-07-24: "the safest bet if we want everything to work unattended").
//
// Applied ONLY to the `@ai-sdk/openai-compatible` route (vLLM / SGLang / LM Studio / llama.cpp /
// other compatible endpoints — see model.ts `fromCatalogModel`). The OpenAI (Responses) and Anthropic
// channels use frequency/presence penalties instead and REJECT `repetition_penalty`, so the floor
// must never reach them.
//
// Overridable: a model whose config already sets `repetition_penalty` — including `1.0` to turn it
// OFF — always wins; the floor only fills the gap when nothing is set. Pure + unit-testable.
export const DEFAULT_REPETITION_PENALTY = 1.05

export const withRepetitionFloor = (model: ModelV2.Info): ModelV2.Info =>
  Object.hasOwn(model.request.body, "repetition_penalty")
    ? model
    : produce(model, (draft) => {
        draft.request.body.repetition_penalty = DEFAULT_REPETITION_PENALTY
      })

/**
 * Does this 4xx body say the endpoint does not know `repetition_penalty`?
 *
 * Reuses `ProviderCapability.rejectsParameter`, the probe's own reader, so there is ONE definition
 * of "the endpoint named the parameter as unsupported" in the tree rather than a second that could
 * differ. Measured shape (a strict hosted gateway, 2026-09-18):
 * `invalid request body: json: unknown field "repetition_penalty"`.
 */
export const rejectsRepetitionPenalty = (message: string): boolean =>
  ProviderCapability.rejectsParameter(message, "repetition_penalty")

/** Endpoints THIS process has already been told reject the floor. */
const rejectedEndpoints = new Set<string>()

/** True when this process must omit `repetition_penalty` for the endpoint. */
export const isFloorRejected = (url: string | undefined): boolean => {
  const key = endpointKey(url)
  return key !== undefined && rejectedEndpoints.has(key)
}

/** Remember a rejection for this process, so the very next request omits the parameter. */
export const rememberFloorRejected = (url: string | undefined): void => {
  const key = endpointKey(url)
  if (key !== undefined) rejectedEndpoints.add(key)
}

/** Test seam: module state must not leak between cases. */
export const clearFloorRejections = (): void => rejectedEndpoints.clear()
