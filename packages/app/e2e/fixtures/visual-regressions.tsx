import { render } from "solid-js/web"
import { DialogProvider } from "@novaclaw/ui/context/dialog"
import { GlobalContext } from "@/context/global"
import { LanguageContext } from "@/context/language"
import { ModelsContext } from "@/context/models"
import { PlatformProvider } from "@/context/platform"
import { ServerContext } from "@/context/server"
import { ServerSyncContext } from "@/context/server-sync"
import { SettingsProvider } from "@/context/settings"
import { SettingsModelsV2 } from "@/components/settings-v2/models"
import { languageStub } from "../../test-browser/language-stub"

const MODEL_ID = "model-with-an-intentionally-long-id-that-must-remain-readable-at-the-narrow-supported-viewport"
const MODEL = {
  id: MODEL_ID,
  name: MODEL_ID,
  api: { id: MODEL_ID },
  limit: { context: 131072, output: 8192 },
  variants: [],
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  provider: {
    id: "long-endpoint",
    name: "https://model-host.example/one/two/three/four/five/six/v1",
    api: {
      type: "aisdk",
      package: "@ai-sdk/openai-compatible",
      url: "https://model-host.example/one/two/three/four/five/six/v1",
    },
  },
}

export function mount() {
  const host = document.createElement("div")
  host.dataset.fixture = "visual-regressions"
  host.style.width = "min(520px, 100vw)"
  document.body.append(host)

  const connection = { type: "http", url: "http://127.0.0.1:4096", http: { url: "http://127.0.0.1:4096" } }
  const sdk = { client: { path: { get: async () => ({ data: { directory: "/tmp/visual" } }) }, v2: {} } }
  const modelConfig = {
    providers: {
      "long-endpoint": {
        name: MODEL.provider.name,
        api: MODEL.provider.api,
        models: {
          [MODEL_ID]: {
            name: MODEL_ID,
            capabilities: MODEL.capabilities,
            request: { body: {} },
          },
        },
      },
    },
  }
  const sync = () => ({
    data: { config: modelConfig, path: { directory: "/tmp/visual" } },
    updateConfig: async () => ({}),
    removeConfig: async () => ({}),
    refetchConfig: async () => ({}),
    refetchProviders: async () => ({ models: new Map([[MODEL.provider.id, [MODEL]]]) }),
  })
  const globalStub = {
    servers: { list: () => [connection] },
    ensureServerCtx: () => ({ sdk, sync: { data: { path: { directory: "/tmp/visual" } } } }),
  }
  const models = {
    list: () => [MODEL],
    remove: () => {},
    visible: () => true,
    setVisibility: () => {},
    tier: { get: () => "guess", set: () => {} },
  }

  const dispose = render(
    () => (
      <PlatformProvider value={{ platform: "web" } as never}>
        <SettingsProvider>
          <LanguageContext.Provider value={languageStub as never}>
            <GlobalContext.Provider value={globalStub as never}>
              <ServerContext.Provider value={{ current: connection } as never}>
                <ServerSyncContext.Provider value={sync as never}>
                  <ModelsContext.Provider value={models as never}>
                    <DialogProvider>
                      <SettingsModelsV2 />
                    </DialogProvider>
                  </ModelsContext.Provider>
                </ServerSyncContext.Provider>
              </ServerContext.Provider>
            </GlobalContext.Provider>
          </LanguageContext.Provider>
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
  return () => {
    dispose()
    host.remove()
  }
}
