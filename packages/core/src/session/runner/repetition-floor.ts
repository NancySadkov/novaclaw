import { produce } from "immer"
import type { ModelV2 } from "../../model"

// Unattended-safety floor for local / openai-compatible models. Without a repetition penalty most
// small models LOOP, which is fatal for unattended runs — so default `repetition_penalty` to a
// light 1.05 (owner 2026-07-24: "the safest bet if we want everything to work unattended").
//
// Applied ONLY to the `@ai-sdk/openai-compatible` route (vLLM / Ollama / LM Studio / llama.cpp /
// local endpoints — see model.ts `fromCatalogModel`). The OpenAI (Responses) and Anthropic
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
