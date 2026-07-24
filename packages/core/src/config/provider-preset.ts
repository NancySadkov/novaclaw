export * as ConfigProviderPreset from "./provider-preset"

import { Schema } from "effect"

// Provider IMPORT presets — the friendly "pick a provider" catalog behind Settings → Models →
// Add models. PURE DATA, deliberately not adapters: every preset rides one of the three in-tree
// API channels (session/runner/model.ts fromCatalogModel dispatches on exactly these strings —
// nothing is ever import()ed by package name), and an external provider never adds kernel code.
//
// SELF-HEALING is the design driver (AGENTS.md → self-healing): the BUILTINS below are
// DEFAULTS, overridable at runtime through the `provider_presets` config key. When a vendor
// moves its endpoint, any working model can repair the preset with one
// `PATCH /config {"provider_presets":{"<id>":{"baseURL":"…"}}}` — no config-file editing, no
// rebuild. The same key adds brand-new presets (unknown id = a new entry) or hides a builtin
// (`"hidden": true`). Already-imported providers are repaired the same way via
// `providers.<id>.api.url`; presets only shape FUTURE imports.

/** The in-tree API channels a preset may select — the closed adapter set. Baking the closed
 *  set into the schema means a runtime "fix" can never invent a fourth channel string. */
export const ApiChannel = Schema.Literals(["@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible"])
export type ApiChannel = Schema.Schema.Type<typeof ApiChannel>

/** How the discovery probe authenticates its GET {baseURL}/models. Turn-time auth is owned by
 *  the API channel itself (bearer for openai/openai-compatible, x-api-key for anthropic). */
export const AuthStyle = Schema.Literals(["bearer", "anthropic"])
export type AuthStyle = Schema.Schema.Type<typeof AuthStyle>

export class Info extends Schema.Class<Info>("ConfigV2.ProviderPreset")({
  name: Schema.String.pipe(Schema.optional).annotate({ description: "Display name shown on the preset card" }),
  description: Schema.String.pipe(Schema.optional).annotate({
    description: "One-line plain-language description shown under the name",
  }),
  baseURL: Schema.String.pipe(Schema.optional).annotate({
    description: "API base URL including any /v1 segment (e.g. https://api.deepseek.com/v1)",
  }),
  keyURL: Schema.String.pipe(Schema.optional).annotate({
    description: "Where the user creates an API key (linked from the import flow)",
  }),
  api: ApiChannel.pipe(Schema.optional).annotate({
    description: "In-tree API channel; defaults to @ai-sdk/openai-compatible",
  }),
  authStyle: AuthStyle.pipe(Schema.optional).annotate({
    description: "Model-discovery auth style; defaults to bearer",
  }),
  hidden: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Hide this preset from the import flow (overrides can hide builtins)",
  }),
}) {}

/** Built-in defaults. URLs verified live 2026-07-21 (each answers GET {baseURL}/models; z.ai
 *  added + verified 2026-07-24 — its /models is auth-gated, like anthropic's, so it lists once a
 *  key is supplied). */
export const BUILTINS: Record<string, Info> = {
  deepseek: Info.make({
    name: "DeepSeek",
    description: "DeepSeek chat and reasoning models",
    baseURL: "https://api.deepseek.com/v1",
    keyURL: "https://platform.deepseek.com/api_keys",
    api: "@ai-sdk/openai-compatible",
  }),
  openai: Info.make({
    name: "OpenAI",
    description: "GPT models from OpenAI",
    baseURL: "https://api.openai.com/v1",
    keyURL: "https://platform.openai.com/api-keys",
    api: "@ai-sdk/openai",
  }),
  anthropic: Info.make({
    name: "Anthropic",
    description: "Claude models from Anthropic",
    baseURL: "https://api.anthropic.com/v1",
    keyURL: "https://console.anthropic.com/settings/keys",
    api: "@ai-sdk/anthropic",
    authStyle: "anthropic",
  }),
  moonshot: Info.make({
    name: "Kimi (Moonshot AI)",
    description: "Kimi models from Moonshot AI",
    baseURL: "https://api.moonshot.ai/v1",
    keyURL: "https://platform.moonshot.ai/console/api-keys",
    api: "@ai-sdk/openai-compatible",
  }),
  zai: Info.make({
    name: "Z.ai (GLM)",
    description: "GLM chat, reasoning, and coding models from Z.ai",
    baseURL: "https://api.z.ai/api/paas/v4",
    keyURL: "https://z.ai/manage-apikey/apikey-list",
    api: "@ai-sdk/openai-compatible",
  }),
}

/** Drop undefined fields so a sparse override never clobbers a builtin value with undefined. */
const defined = (value: Info): Partial<Info> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<Info>

/**
 * The effective preset catalog: builtins ⊕ config overrides, field-wise per id. Overrides win
 * per FIELD (a `{baseURL}` fix keeps the builtin name/keyURL); unknown ids become new presets.
 * `hidden` entries are kept in the record — consumers (the import flow) filter them, so an
 * agent inspecting the served catalog still sees WHY a preset is absent.
 */
export function effective(overrides?: Record<string, Info>): Record<string, Info> {
  const result: Record<string, Info> = { ...BUILTINS }
  for (const [id, override] of Object.entries(overrides ?? {})) {
    const base = result[id]
    result[id] = Info.make({ ...(base === undefined ? {} : defined(base)), ...defined(override) })
  }
  return result
}
