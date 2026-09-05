import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { For, Show, createMemo, createResource, onCleanup, onMount, type Component } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { localModelStop } from "@/utils/fs-api"
import { instanceResources } from "@/utils/resource-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsExplainV2 } from "./explain"

// Imported for this file's own use AND re-exported so existing importers keep working. The
// implementation lives in a component-free sibling so its test can load without dragging Kobalte in;
// a bare `export … from` would re-export without binding it locally.
import { formatResourceBytes, memoryPressureLevel } from "./instance-resources-format"
import { scopedDirectory } from "@/utils/routing-directory"

export { formatResourceBytes } from "./instance-resources-format"

export const InstanceResources: Component = () => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const sync = useServerSync()
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const [usage, actions] = createResource(connection, (value) => instanceResources(value.http))
  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    timer = setInterval(() => void actions.refetch(), 5_000)
  })
  onCleanup(() => timer && clearInterval(timer))

  const stop = async () => {
    const current = connection()
    if (!current) return
    const directory = scopedDirectory(sync().data.path)
    await localModelStop(current.http, { directory })
    await actions.refetch()
  }
  const hostMemory = createMemo(() => {
    const memory = usage()?.memory
    if (!memory) return language.t("settings.storage.resources.loading")
    if (!memory.known) return memory.reason
    return language.t("settings.storage.resources.memoryValue", {
      used: formatResourceBytes(memory.usedBytes),
      total: formatResourceBytes(memory.limitBytes),
    })
  })
  const canStop = createMemo(() => {
    const stage = usage()?.localModel.stage
    return (
      stage === "checking" ||
      stage === "downloading-runtime" ||
      stage === "installing-runtime" ||
      stage === "downloading-model" ||
      stage === "starting" ||
      stage === "ready" ||
      stage === "stopping"
    )
  })

  return (
    <section class="flex flex-col gap-2" data-slot="instance-resources">
      {/* No section blurb: the rows carry their own detail as hover/tap hints (owner, 2026-08-13 —
          "descriptions pop when the user hovers or taps these indicators"). */}
      <h3 class="settings-v2-section-title">{language.t("settings.storage.resources.title")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.storage.resources.hostMemory")}
          description={
            <>
              {hostMemory()}
              <SettingsExplainV2 label={language.t("settings.storage.resources.hostMemory")}>
                {language.t("settings.storage.resources.description")}
              </SettingsExplainV2>
            </>
          }
        >
          <span class="select-text text-[12px] text-v2-text-text-muted">{memoryPressureLevel(usage())}</span>
        </SettingsRowV2>
        {/* The value column carries state-or-bytes; the prose detail is a focus-reachable disclosure
            (uix.md §1.4), not the mouse-only row hint it used to be. */}
        <For each={usage()?.ram ?? []}>
          {(item) => (
            <SettingsRowV2
              title={item.label}
              description={<SettingsExplainV2 label={item.label}>{item.detail}</SettingsExplainV2>}
            >
              <span class="select-text text-[12px] text-v2-text-text-muted">
                {item.bytes === undefined
                  ? (item.state ?? language.t("settings.storage.resources.unknown"))
                  : formatResourceBytes(item.bytes)}
              </span>
            </SettingsRowV2>
          )}
        </For>
      </SettingsListV2>

      <div class="pt-1">
        <h3 class="settings-v2-section-title">{language.t("settings.storage.resources.disk")}</h3>
      </div>
      <SettingsListV2>
        <For each={usage()?.disk ?? []}>
          {(item) => (
            <SettingsRowV2
              title={item.label}
              description={
                <>
                  {item.path ?? item.state ?? ""}
                  <SettingsExplainV2 label={item.label}>{item.detail}</SettingsExplainV2>
                </>
              }
            >
              <span class="select-text text-[12px] text-v2-text-text-muted">
                {item.bytes === undefined
                  ? language.t("settings.storage.resources.unknown")
                  : formatResourceBytes(item.bytes)}
              </span>
            </SettingsRowV2>
          )}
        </For>
      </SettingsListV2>

      <Show when={usage()?.localModel.supported}>
        <div class="flex items-center justify-between gap-3 rounded-lg bg-v2-background-bg-deep px-3 py-2">
          <div class="min-w-0">
            <div class="text-[12px] font-medium text-v2-text-text-base">
              {language.t("settings.storage.resources.localModel")}
            </div>
            <div class="select-text text-[11px] text-v2-text-text-muted">
              {usage()?.localModel.message ?? usage()?.localModel.stage}
            </div>
          </div>
          <ButtonV2 size="small" variant="neutral" disabled={!canStop()} onClick={() => void stop()}>
            {language.t("settings.storage.resources.stop")}
          </ButtonV2>
        </div>
      </Show>
      <Show when={usage.error}>
        <p class="select-text text-[12px] text-v2-state-fg-danger">
          {usage.error instanceof Error ? usage.error.message : String(usage.error)}
        </p>
      </Show>
    </section>
  )
}
