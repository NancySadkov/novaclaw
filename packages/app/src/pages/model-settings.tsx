import { Show, createMemo } from "solid-js"
import { useNavigate, useSearchParams } from "@solidjs/router"
import type { ConfigV2Provider as ProviderConfig } from "@novaclaw/sdk/v2/client"
import { ModelConfigScreen } from "@/components/settings-v2/dialog-model-config"
import { useProviders } from "@/hooks/use-providers"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"

// ONE model's configuration as a full-screen route, like the officer's settings page
// (`/officers/:agentID/settings`). The Models list's Configure button navigates here; Back returns to
// the list.
//
// The ids travel as SEARCH PARAMS, not path segments: a catalog model id may contain a slash
// (`meta-llama/Llama-3.1-8B`), which a `:modelID` segment would split. This page is where the
// catalog is resolved (it has the router and the providers context), and the screen stays a pure
// component that a render harness can mount without either.
type ModelConfigQuery = { providerID?: string; modelID?: string; returnTo?: string }

export function ModelSettingsPage() {
  const [query] = useSearchParams<ModelConfigQuery>()
  const navigate = useNavigate()
  const providers = useProviders()
  const sync = useServerSync()
  const language = useLanguage()

  const providerID = () => query.providerID ?? ""
  const modelID = () => query.modelID ?? ""
  const providerConfig = (): ProviderConfig | undefined => sync().data.config?.providers?.[providerID()]
  const catalog = createMemo(() => providers.model(providerID(), modelID()))
  const catalogProvider = () => [...providers.all().values()].find((provider) => provider.id === providerID())

  const dismiss = () => {
    const target = query.returnTo
    navigate(target?.startsWith("/") && !target.startsWith("//") ? target : "/models")
  }

  const defaults = () => {
    const model = catalog()
    if (!model) return undefined
    return {
      capabilities: {
        tools: model.capabilities.tools,
        input: [...model.capabilities.input],
        output: [...model.capabilities.output],
      },
    }
  }

  return (
    <Show
      when={providerID() !== "" && modelID() !== ""}
      fallback={
        <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-v2-text-text-muted">
          <span>{language.t("settings.models.config.missing")}</span>
          <button type="button" class="text-xs text-v2-text-text-accent hover:underline" onClick={dismiss}>
            {language.t("agentConfig.back")}
          </button>
        </div>
      }
    >
      <ModelConfigScreen
        providerID={providerID()}
        modelID={modelID()}
        modelName={providerConfig()?.models?.[modelID()]?.name ?? catalog()?.name ?? modelID()}
        apiModelID={providerConfig()?.models?.[modelID()]?.api?.id ?? catalog()?.api?.id ?? modelID()}
        providerApi={providerConfig()?.api ?? catalogProvider()?.api}
        defaults={defaults()}
        onDismiss={dismiss}
      />
    </Show>
  )
}
