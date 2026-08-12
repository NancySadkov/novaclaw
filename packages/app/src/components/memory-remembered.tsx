import { type Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { RequiresLevel } from "@/context/expertise"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { memoryInvalidate, memoryList, type MemoryRow } from "@/utils/memory-api"

/**
 * The **Remembered** list — what NovaClaw has learned, in plain sentences.
 *
 * Extracted from the Memory settings tab so the Memory APP can hold it (owner, 2026-08-12: *"all
 * the settings, like `Remembered` list, should be integrated into this Memory app"*). The app is
 * where a person goes to ask "what do you know about me", and the answer was living in a settings
 * panel behind a graph they could not read.
 *
 * ⚠️ It owns its own fetch rather than taking rows as a prop. The two callers refresh on different
 * events — the settings tab after an import or a bulk forget, the app on open — and threading one
 * parent's resource through both would tie each surface's staleness to the other's.
 */
export const MemoryRemembered: Component<{
  /** The chat whose scope reads as "this chat"; absent outside a session. */
  sessionID?: string
  /** Bumped by a caller that has just changed the set, to force a re-read. */
  revision?: number
  class?: string
}> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const serverSync = useServerSync()
  const [localTick, setLocalTick] = createSignal(0)

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const directory = () => serverSync().data.path?.directory ?? ""
  const sessionScope = () => (props.sessionID ? `session:${props.sessionID}` : undefined)

  const [memories, { refetch }] = createResource(
    () => {
      const cn = conn()
      return cn ? { cn, dir: directory(), t: (props.revision ?? 0) + localTick() } : undefined
    },
    ({ cn, dir }) => memoryList(cn.http, { directory: dir, limit: 500 }).catch(() => [] as MemoryRow[]),
  )

  const count = () => memories()?.length ?? 0

  /** Whose memory this is, in the user's terms — never the raw `session:<id>` scope string. */
  const scopeLabel = (scope: string): string => {
    if (scope === sessionScope()) return language.t("settings.memory.scope.chat")
    if (scope === "global") return language.t("settings.memory.scope.global")
    if (scope.startsWith("session:")) return language.t("settings.memory.scope.otherChat")
    return language.t("settings.memory.scope.global")
  }

  const forget = async (row: MemoryRow) => {
    const cn = conn()
    if (!cn) return
    await memoryInvalidate(cn.http, { directory: directory(), id: row.id }).catch((error: unknown) =>
      showToast({
        variant: "error",
        title: language.t("settings.memory.toast.failed"),
        description: error instanceof Error ? error.message : String(error),
      }),
    )
    setLocalTick((value) => value + 1)
    void refetch()
  }

  return (
    <div class={props.class} data-component="memory-remembered">
      <div class="settings-v2-section-title">
        {count() > 0
          ? language.t("settings.memory.list.title", { count: count() })
          : language.t("settings.memory.list.titleEmpty")}
      </div>
      <Show
        when={count() > 0}
        fallback={<p class="settings-v2-field-description">{language.t("settings.memory.list.empty")}</p>}
      >
        <div class="flex flex-col gap-1.5 overflow-y-auto pr-1">
          <For each={memories()}>
            {(row) => (
              <div class="flex items-start justify-between gap-3 rounded-md border border-[var(--nc-border-subtle,rgba(255,255,255,0.08))] px-3 py-2">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-sm leading-snug break-words">{row.text}</span>
                  <span class="text-xs opacity-60">{scopeLabel(row.scope)}</span>
                </div>
                {/* Forgetting stays ADVANCED, unchanged. Reading what is remembered is for everyone;
                    deleting it is the irreversible half and keeps its guard. */}
                <RequiresLevel min="advanced">
                  <ButtonV2
                    size="small"
                    variant="ghost-muted"
                    icon="close-small"
                    aria-label={language.t("settings.memory.forget.action")}
                    title={language.t("settings.memory.forget.action")}
                    onClick={() => void forget(row)}
                  />
                </RequiresLevel>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
