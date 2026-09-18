import { Show, createMemo } from "solid-js"
import { useNavigate, useSearchParams } from "@solidjs/router"
import type { ConfigV2Provider as ProviderConfig } from "@novaclaw/sdk/v2/client"
import { ModelConfigScreen } from "@/components/settings-v2/dialog-model-config"
import { useProviders } from "@/hooks/use-providers"
import { useServerSync } from "@/context/server-sync"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { providerProbe, type ProbeResult } from "@/utils/fs-api"
import { scopedDirectory } from "@/utils/routing-directory"

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
  const server = useServer()
  const global = useGlobal()
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

  // The connection and routing directory the probe needs are owned HERE, not by the screen: the
  // screen is deliberately mountable without either (its browser harness proves it), and a probe is
  // a socket, which a harness must never open. When the instance cannot be resolved the screen gets
  // no probe and Save falls back to the syntactic normalization in `persist`.
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const probe = async (input: { baseURL: string; apiKey?: string }): Promise<ProbeResult | undefined> => {
    const conn = connection()
    const directory = scopedDirectory(sync().data.path)
    if (!conn || !directory) return undefined
    // ⚠️ Bounded: Save is a foreground action and the endpoint may be black-holed. Two candidates
    // at the server's discovery timeout could stall for twice that, so the client gives up first and
    // `persist` falls back to the syntactic canonical.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      return await providerProbe(conn.http, {
        directory,
        providerID: providerID(),
        baseURL: input.baseURL,
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        signal: controller.signal,
      })
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
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
        probe={probe}
        onDismiss={dismiss}
      />
    </Show>
  )
}
