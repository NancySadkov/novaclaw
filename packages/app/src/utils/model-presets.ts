// Models item (d) — known-family sampling presets. A model id the New-Model discovery
// recognizes auto-fills the family's vendor-recommended sampling (the qwen numbers are our own
// Spark recipe, which mirrors Qwen's non-thinking recommendation); anything unrecognized stays
// untouched — the user only tweaks, never starts from silence. Pure and order-sensitive: first
// match wins, so keep more specific patterns above generic ones.

export interface ModelPreset {
  readonly family: string
  readonly body: Record<string, number>
}

const PRESETS: ReadonlyArray<{ match: RegExp } & ModelPreset> = [
  {
    family: "gpt-oss",
    match: /gpt[-_]?oss/,
    body: { temperature: 1.0, top_p: 1.0 },
  },
  {
    family: "qwen",
    match: /qwen/,
    body: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 0, repetition_penalty: 1.05 },
  },
  {
    family: "deepseek",
    match: /deepseek/,
    body: { temperature: 0.6, top_p: 0.95 },
  },
  {
    family: "llama",
    match: /llama/,
    body: { temperature: 0.6, top_p: 0.9 },
  },
  {
    family: "gemma",
    match: /gemma/,
    body: { temperature: 1.0, top_p: 0.95, top_k: 64 },
  },
  {
    family: "glm",
    match: /glm/,
    body: { temperature: 0.6, top_p: 0.95 },
  },
  {
    family: "kimi",
    match: /kimi/,
    body: { temperature: 0.6 },
  },
]

export const matchPreset = (modelID: string): ModelPreset | undefined => {
  const id = modelID.toLowerCase()
  const hit = PRESETS.find((preset) => preset.match.test(id))
  return hit === undefined ? undefined : { family: hit.family, body: hit.body }
}
