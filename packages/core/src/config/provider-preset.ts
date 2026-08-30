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

/**
 * Built-in defaults — **deliberately EMPTY, and this is a product rule rather than an oversight.**
 *
 * 🔴 NovaClaw's north star says the deliverable *"runs entirely against local models: no paid APIs,
 * and your data never egresses"*, and design principle 4 repeats it: the data plane never leaves the
 * machine. Until 2026-08-26 this record shipped five branded public-cloud cards — DeepSeek, OpenAI,
 * Anthropic, Moonshot, Z.ai — each with a vendor endpoint and a *"get an API key"* purchase link,
 * and the New Model dialog rendered them on a clean install. Choosing one filled its public
 * `baseURL`, collected a credential, and from the next turn every composed system prompt, provider
 * history, project grounding, recalled memory, tool definition and attachment went to a commercial
 * endpoint. That is not an advanced misconfiguration a user wandered into; it was the first-party
 * happy path implementing precisely the mode the contract forbids, under a UI line that reassured
 * the user about where their KEY was stored and said nothing about where their CHATS were going.
 * (Codex review NC-SEC-014. Ruling 10's own adversary pass reaches the same place from the other
 * side: the paid tier "is excluded by design-principle #4".)
 *
 * ⚠️ **What was NOT deleted, and why the distinction matters.** The three `ApiChannel` protocol
 * implementations stay. They are transport, and the endpoints a user actually points them at —
 * vLLM, llama.cpp, LM Studio, or another compatible local server — speak them. Deleting a wire format
 * because a cloud vendor also speaks it would remove local capability to make a point.
 *
 * ⚠️ **And this is not by itself an egress boundary.** `effective()` below still merges runtime
 * `provider_presets` overrides, and the config surface still accepts an arbitrary custom endpoint,
 * because self-healing requires both. Refusing a public destination at the probe, config-admission
 * and turn-dispatch seams is a separate locality policy that does not exist yet (NC-SEC-014's second
 * half). What this record now guarantees is narrower and worth stating exactly: **NovaClaw ships no
 * public-cloud destination and no commercial key link of its own.** A user who deliberately adds one
 * is choosing it; a user who opened the dialog on a clean install is no longer being offered it.
 */
export const BUILTINS: Record<string, Info> = {}

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
