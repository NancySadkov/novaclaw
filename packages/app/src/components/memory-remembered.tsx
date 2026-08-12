import { type Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { RequiresLevel } from "@/context/expertise"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { memoryInvalidate, memoryList, type MemoryRow } from "@/utils/memory-api"
import { instanceDiagnosis } from "@/utils/resource-api"

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

  /**
   * 🔴 Is the store BROKEN, or merely empty?
   *
   * They are indistinguishable from `list` alone — a degraded memory client returns `[]`, exactly
   * like a fresh install. Measured 2026-08-12 by fault injection: with the graph unopenable this
   * panel said *"Nothing remembered yet … no setup needed"*, both halves false, and a user would
   * have chatted for weeks believing NovaClaw was learning. The server-side board is the one place
   * that knows the difference, so ask it.
   *
   * ⚠️ No `probe`, so this contacts nobody and costs no egress — the board is free unless a user
   * deliberately asks it to reach a provider.
   */
  const [health, healthActions] = createResource(
    // ⚠️ Keyed on the LIST having settled, not on the connection. The engine opens lazily, so a
    // board read at mount reports "not opened yet" — `unknown`, not `problem` — and this panel would
    // fall through to the empty state exactly as before the fix. The list is what demands the
    // subsystem; only after it resolves does the board know anything.
    () => {
      const cn = conn()
      const rows = memories()
      return cn !== undefined && rows !== undefined ? { cn, settled: rows.length } : undefined
    },
    ({ cn }) => instanceDiagnosis(cn.http).catch(() => undefined),
  )
  const unavailable = () =>
    health()?.signals.some((signal) => signal.id === "memory" && signal.status === "problem") === true

  const [retrying, setRetrying] = createSignal(false)
  const retry = async () => {
    setRetrying(true)
    try {
      // Demand the subsystem again: `list` goes through the capability, so a successful open flips
      // the board's signal on the next read. One user-visible action, two refreshes.
      await refetch()
      await healthActions.refetch()
    } finally {
      setRetrying(false)
    }
  }

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
        when={!unavailable()}
        fallback={
          <div class="flex flex-col items-start gap-2" data-slot="memory-unavailable">
            <p class="settings-v2-field-description">
              <strong>{language.t("settings.memory.unavailable.title")}</strong>
              <br />
              {language.t("settings.memory.unavailable.body")}
            </p>
            <ButtonV2 size="small" variant="outline" disabled={retrying()} onClick={() => void retry()}>
              {retrying()
                ? language.t("settings.memory.unavailable.retrying")
                : language.t("settings.memory.unavailable.retry")}
            </ButtonV2>
          </div>
        }
      >
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
      </Show>
    </div>
  )
}
