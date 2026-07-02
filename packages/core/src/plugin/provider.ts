// NovaClaw is local-first: it bundles only the generic OpenAI-compatible provider (local vLLM / any
// OpenAI-compatible endpoint — what every novaclaw.jsonc provider uses) plus the dynamic (BYO) provider.
// All other cloud provider integrations novaclaw shipped were removed to shrink the dependency surface —
// see detach-triage.md. Onboarding a fresh user (before they have a local endpoint) is a separate,
// deliberate step (few-shot via a free external model, or a bundled small local model) — not a pile of
// bundled provider SDKs.
import { DynamicProviderPlugin } from "./provider/dynamic"
import { OpenAICompatiblePlugin } from "./provider/openai-compatible"
import type { PluginInternal } from "./internal"
import type { Scope } from "effect"

export const ProviderPlugins: PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>[] = [
  OpenAICompatiblePlugin,
  DynamicProviderPlugin,
]
