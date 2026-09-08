// V2 model resolution: a model's per-model config `options` (carried as request.body)
// are model defaults. The native LLM transport REJECTS an `http.body` overlay that
// contains protocol-owned sampling fields (temperature, top_p, top_k, presence/frequency
// penalty, max_tokens, seed, stop) — those belong in the canonical `generation` options.
// Only genuine provider extras (min_p, max_p, repetition_penalty, …) belong in the
// http.body overlay. Without this split, every V2 turn fails with
// "http.body cannot overlay protocol-owned field(s): top_p, top_k, temperature, …".
//
// Pure + unit-testable. Maps both snake_case (config/wire) and camelCase keys onto the
// canonical camelCase `GenerationOptions` field names.

const GENERATION_KEYS: Record<string, string> = {
  temperature: "temperature",
  top_p: "topP",
  topP: "topP",
  top_k: "topK",
  topK: "topK",
  max_tokens: "maxTokens",
  maxTokens: "maxTokens",
  maxOutputTokens: "maxTokens",
  frequency_penalty: "frequencyPenalty",
  frequencyPenalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
  presencePenalty: "presencePenalty",
  seed: "seed",
  stop: "stop",
}

export function splitModelSampling(body: Record<string, unknown>): {
  generation: Record<string, unknown>
  http: Record<string, unknown>
} {
  const generation: Record<string, unknown> = {}
  const http: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue
    const mapped = GENERATION_KEYS[key]
    if (mapped !== undefined) generation[mapped] = value
    else http[key] = value
  }
  return { generation, http }
}
