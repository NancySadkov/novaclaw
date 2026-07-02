// NovaClaw is local-first: it bundles only the generic OpenAI-compatible + dynamic (BYO-endpoint)
// providers plus a few well-known onboarding providers (Anthropic/OpenAI/Google) so a user with an
// existing key can bootstrap. The ~27 other cloud provider integrations opencode shipped were removed
// to shrink the dependency surface — see detach-triage.md. Users configure any endpoint via
// openai-compatible / dynamic; the models.dev catalog still lists others but they're not bundled.
import { AnthropicPlugin } from "./provider/anthropic"
import { DynamicProviderPlugin } from "./provider/dynamic"
import { GooglePlugin } from "./provider/google"
import { OpenAIPlugin } from "./provider/openai"
import { OpenAICompatiblePlugin } from "./provider/openai-compatible"
import type { PluginInternal } from "./internal"
import type { Scope } from "effect"

export const ProviderPlugins: PluginInternal.Plugin<PluginInternal.Requirements | Scope.Scope>[] = [
  AnthropicPlugin,
  GooglePlugin,
  OpenAICompatiblePlugin,
  OpenAIPlugin,
  DynamicProviderPlugin,
]
