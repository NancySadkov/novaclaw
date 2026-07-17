import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import type { Accessor } from "solid-js"
import { selectProviderCatalog } from "./provider-catalog"
import { modelCost } from "@/utils/model-catalog"

// NovaClaw bundles only the generic OpenAI-compatible provider (local vLLM / any OpenAI-compatible
// endpoint). Users add a local endpoint via it or a custom provider; see detach-triage.md.
export const popularProviders = ["openai-compatible"]
const popularProviderSet = new Set(popularProviders)

export function useProviders(directory?: Accessor<string | undefined>) {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = () => (directory ? directory() : decode64(params.dir))
  const providers = () => {
    const value = dir()
    const projectStore = value ? serverSync().child(value)[0] : undefined
    // Always offer the global catalog as the fallback; selectProviderCatalog prefers the
    // directory-specific one once it is ready, but never leaves the picker empty while it loads.
    return selectProviderCatalog({
      directory: value,
      catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      global: serverSync().data.provider,
    })
  }
  return {
    all: () => providers().all,
    /** Non-deprecated models of one provider, catalog order. */
    models: (providerID: string) => providers().models.get(providerID) ?? [],
    /** One model by (providerID, modelID), if listed. */
    model: (providerID: string, modelID: string) =>
      (providers().models.get(providerID) ?? []).find((m) => m.id === modelID),
    default: () => providers().default,
    popular: () =>
      pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "novaclaw" || (providers().models.get(id) ?? []).some((m) => modelCost(m)?.input)),
        ),
      ]
    },
  }
}
