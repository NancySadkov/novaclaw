import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useServerSync } from "@/context/server-sync"
import { useConfirm } from "@/components/dialog-confirm"
import { RequiresLevel } from "@/context/expertise"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import {
  memoryClearScope,
  memoryIngest,
  memoryInvalidate,
  memoryList,
  memoryRemember,
  type MemoryRow,
} from "@/utils/memory-api"
import { buildMemoryBundle, importScope, parseMemoryBundle } from "./memory-bundle"
import "./settings-v2.css"

// The Memory tab (notes/kb-graph-plan.md §5) — the lay-first home for "what NovaClaw remembers".
// Out of the box memory is fully automatic (recall + extract + consolidate under the hood); this tab
// just makes it legible and controllable the way a normal person expects their own data to be:
//   • a friendly, read-only list of what's remembered (teach-don't-gatekeep — the mission),
//   • Export (download a backup) / Import (restore) — the portable memory bundle (memory-bundle.ts),
//   • Clear — a fresh start, auto-export-first + confirm.
// The per-memory Forget control is gated to Advanced+ (the raw edit surface lives in the Registry/Debug
// app; this tab keeps the everyday controls). Reads degrade to empty when memory is off/unavailable —
// the tab shows the friendly empty state, never an error.

const BACKUP_FILENAME = "novaclaw-memory.json"

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export const SettingsMemoryV2: Component<{ sessionID?: string }> = (props) => {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const serverSync = useServerSync()
  const confirm = useConfirm()

  // The on/off privacy switch (config.memory.enabled, default on). Off pauses the runtime flows
  // (recall/extract/tool/consolidation) instance-wide; the list + export/clear below still work so you
  // can manage what's already stored. Opt-out: enabled unless explicitly false.
  const memoryConfig = createMemo(
    () =>
      (serverSync().data.config as { memory?: { enabled?: boolean; embedding?: { url?: string; model?: string } } }).memory ?? {},
  )
  const enabled = () => memoryConfig().enabled !== false
  // The VECTOR leg's device (Advanced). Measured: hybrid vector+FTS retrieval 85% vs 77% keyword-only.
  // Unset = keyword-only search, which is a valid configuration, not a broken one. The server reads
  // this live (2s TTL), so pointing at a device takes effect without a restart; blanking a field is
  // "use default" over the patch-merge wire, which the reader treats as unconfigured.
  const embedding = () => memoryConfig().embedding ?? {}
  const persistEmbedding = (patch: { url?: string; model?: string }) =>
    void serverSync()
      .updateConfig({ memory: { ...memoryConfig(), embedding: { ...embedding(), ...patch } } } as never)
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("settings.memory.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
  const setEnabled = (value: boolean) =>
    void serverSync()
      .updateConfig({ memory: { ...memoryConfig(), enabled: value } } as never)
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("settings.memory.toast.failed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )

  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  // Memory is a server-GLOBAL graph; `directory` is only request routing — the server's home works.
  const directory = () => {
    const path = ctx()?.sync.data.path
    return path?.home || path?.directory || ""
  }
  const [tick, setTick] = createSignal(0)
  const refresh = () => setTick((t) => t + 1)
  const [busy, setBusy] = createSignal(false)

  const sessionScope = () => (props.sessionID ? `session:${props.sessionID}` : undefined)

  const [memories] = createResource(
    () => {
      const cn = conn()
      return cn ? { cn, dir: directory(), t: tick() } : undefined
    },
    ({ cn, dir }) => memoryList(cn.http, { directory: dir, limit: 500 }).catch(() => [] as MemoryRow[]),
  )

  const scopeLabel = (scope: string): string => {
    if (scope === sessionScope()) return language.t("settings.memory.scope.chat")
    if (scope === "global") return language.t("settings.memory.scope.global")
    if (scope.startsWith("session:")) return language.t("settings.memory.scope.otherChat")
    return language.t("settings.memory.scope.global")
  }

  const failed = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.memory.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })

  /** Fetch every memory (valid only) as the backup bundle text; empty string when there's nothing. */
  const collectBundle = async (): Promise<string> => {
    const cn = conn()
    if (!cn) return ""
    const rows = await memoryList(cn.http, { directory: directory(), limit: 100000 }).catch(() => [] as MemoryRow[])
    if (!rows.length) return ""
    return buildMemoryBundle(rows, new Date().toISOString())
  }

  const exportMemory = async () => {
    const bundle = await collectBundle()
    if (!bundle) {
      showToast({ variant: "default", title: language.t("settings.memory.export.empty") })
      return
    }
    downloadText(BACKUP_FILENAME, bundle)
    showToast({ variant: "success", icon: "circle-check", title: language.t("settings.memory.export.toast") })
  }

  let fileInput: HTMLInputElement | undefined
  let docInput: HTMLInputElement | undefined

  // Add a DOCUMENT to memory: the file is chunked into searchable passages server-side, so a big
  // manual becomes findable without anyone pasting it into a chat.
  const onDocumentPicked = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ""
    if (!file) return
    const cn = conn()
    if (!cn) return
    setBusy(true)
    const result = await memoryIngest(cn.http, {
      directory: directory(),
      text: await file.text(),
      name: file.name,
    }).catch((error: unknown) => {
      failed(error)
      return undefined
    })
    setBusy(false)
    if (!result) return
    refresh()
    showToast({
      variant: "success",
      icon: "circle-check",
      title:
        result.stored === 0
          ? language.t("settings.memory.ingest.already", { name: file.name })
          : language.t("settings.memory.ingest.toast", { count: result.stored, name: file.name }),
    })
  }
  const onFilePicked = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = "" // allow re-picking the same file later
    if (!file) return
    const cn = conn()
    if (!cn) return
    const parsed = parseMemoryBundle(await file.text())
    if (!parsed.ok) {
      showToast({
        variant: "error",
        title: language.t("settings.memory.import.invalid.title"),
        description: language.t(
          parsed.error === "version" ? "settings.memory.import.invalid.version" : "settings.memory.import.invalid.description",
        ),
      })
      return
    }
    if (!parsed.memories.length) {
      showToast({ variant: "default", title: language.t("settings.memory.import.empty") })
      return
    }
    const proceed = await confirm({
      title: language.t("settings.memory.import.confirm.title"),
      description: language.t("settings.memory.import.confirm.description", { count: parsed.memories.length }),
      confirmLabel: language.t("settings.memory.import.confirm.action"),
    })
    if (!proceed) return
    setBusy(true)
    let ok = 0
    for (const memory of parsed.memories) {
      await memoryRemember(cn.http, {
        directory: directory(),
        text: memory.text,
        ...(memory.name ? { name: memory.name } : {}),
        scope: importScope(memory.scope),
        kind: memory.kind,
      })
        .then(() => ok++)
        .catch(() => {})
    }
    setBusy(false)
    refresh()
    if (ok === 0) {
      failed(new Error(language.t("settings.memory.import.none")))
      return
    }
    showToast({ variant: "success", icon: "circle-check", title: language.t("settings.memory.import.toast", { count: ok }) })
  }

  const clearScopes = async (scopes: readonly string[]) => {
    const cn = conn()
    if (!cn) return
    setBusy(true)
    for (const scope of scopes) {
      await memoryClearScope(cn.http, { directory: directory(), scope }).catch(() => {})
    }
    setBusy(false)
    refresh()
  }

  const clearAll = async () => {
    const cn = conn()
    if (!cn) return
    const proceed = await confirm({
      title: language.t("settings.memory.clearAll.confirm.title"),
      description: language.t("settings.memory.clearAll.confirm.description"),
      confirmLabel: language.t("settings.memory.clearAll.confirm.action"),
      destructive: true,
    })
    if (!proceed) return
    // Auto-export-first safety net (§5): the just-confirmed wipe always leaves the user a backup.
    const bundle = await collectBundle()
    if (bundle) downloadText(BACKUP_FILENAME, bundle)
    // Enumerate EVERY scope (include invalidated rows) so "clear all" truly empties the graph.
    const all = await memoryList(cn.http, { directory: directory(), includeInvalid: true, limit: 100000 }).catch(
      () => [] as MemoryRow[],
    )
    const scopes = [...new Set(all.map((row) => row.scope))]
    await clearScopes(scopes)
    showToast({ variant: "success", icon: "circle-check", title: language.t("settings.memory.clearAll.toast") })
  }

  const clearThisChat = async () => {
    const scope = sessionScope()
    if (!scope) return
    const proceed = await confirm({
      title: language.t("settings.memory.clearChat.confirm.title"),
      description: language.t("settings.memory.clearChat.confirm.description"),
      confirmLabel: language.t("settings.memory.clearChat.confirm.action"),
      destructive: true,
    })
    if (!proceed) return
    await clearScopes([scope])
    showToast({ variant: "success", icon: "circle-check", title: language.t("settings.memory.clearChat.toast") })
  }

  const forget = async (row: MemoryRow) => {
    const cn = conn()
    if (!cn) return
    await memoryInvalidate(cn.http, { directory: directory(), id: row.id }).catch(failed)
    refresh()
  }

  const count = () => memories()?.length ?? 0

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.memory.title")}</h2>
        <p class="settings-v2-tab-description">{language.t("settings.memory.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.memory.enabled.title")}
              description={language.t("settings.memory.enabled.description")}
            >
              <div data-action="settings-memory-enabled">
                <Switch checked={enabled()} onChange={setEnabled} hideLabel>
                  {language.t("settings.memory.enabled.title")}
                </Switch>
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        {/* The vector leg's device. ADVANCED on purpose: a normal person should never have to type an
            embedding endpoint — lay-first means it just works when a device is present at deployment. */}
        <RequiresLevel min="advanced">
          <div class="settings-v2-section">
            <div class="settings-v2-section-title">{language.t("settings.memory.embedding.title")}</div>
            <p class="settings-v2-field-description">{language.t("settings.memory.embedding.description")}</p>
            <SettingsListV2>
              <SettingsRowV2
                title={language.t("settings.memory.embedding.url.title")}
                description={language.t("settings.memory.embedding.url.description")}
              >
                <div class="w-full sm:w-[260px]">
                  <TextInputV2
                    type="text"
                    appearance="base"
                    value={embedding().url ?? ""}
                    placeholder="http://192.168.178.40:8001/v1"
                    spellcheck={false}
                    autocomplete="off"
                    data-action="settings-memory-embedding-url"
                    onChange={(event) => persistEmbedding({ url: event.currentTarget.value.trim() })}
                    aria-label={language.t("settings.memory.embedding.url.title")}
                  />
                </div>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.memory.embedding.model.title")}
                description={language.t("settings.memory.embedding.model.description")}
              >
                <div class="w-full sm:w-[260px]">
                  <TextInputV2
                    type="text"
                    appearance="base"
                    value={embedding().model ?? ""}
                    placeholder="qwen3-embedding"
                    spellcheck={false}
                    autocomplete="off"
                    data-action="settings-memory-embedding-model"
                    onChange={(event) => persistEmbedding({ model: event.currentTarget.value.trim() })}
                    aria-label={language.t("settings.memory.embedding.model.title")}
                  />
                </div>
              </SettingsRowV2>
            </SettingsListV2>
          </div>
        </RequiresLevel>

        <div class="settings-v2-section">
          <div class="flex flex-wrap gap-2">
            <ButtonV2 size="small" variant="neutral" disabled={busy()} onClick={() => void exportMemory()}>
              {language.t("settings.memory.export.action")}
            </ButtonV2>
            <ButtonV2 size="small" variant="neutral" disabled={busy()} onClick={() => fileInput?.click()}>
              {language.t("settings.memory.import.action")}
            </ButtonV2>
            <ButtonV2 size="small" variant="neutral" disabled={busy()} onClick={() => docInput?.click()}>
              {language.t("settings.memory.ingest.action")}
            </ButtonV2>
            <ButtonV2 size="small" variant="danger" disabled={busy()} onClick={() => void clearAll()}>
              {language.t("settings.memory.clearAll.action")}
            </ButtonV2>
            <Show when={sessionScope()}>
              <ButtonV2 size="small" variant="danger" disabled={busy()} onClick={() => void clearThisChat()}>
                {language.t("settings.memory.clearChat.action")}
              </ButtonV2>
            </Show>
            <input
              ref={docInput}
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              class="hidden"
              onChange={(event) => void onDocumentPicked(event)}
            />
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              class="hidden"
              onChange={(event) => void onFilePicked(event)}
            />
          </div>
          <p class="settings-v2-field-description">{language.t("settings.memory.io.hint")}</p>
        </div>

        <div class="settings-v2-section">
          <div class="settings-v2-section-title">
            {count() > 0
              ? language.t("settings.memory.list.title", { count: count() })
              : language.t("settings.memory.list.titleEmpty")}
          </div>
          <Show
            when={count() > 0}
            fallback={<p class="settings-v2-field-description">{language.t("settings.memory.list.empty")}</p>}
          >
            <div class="flex flex-col gap-1.5 max-h-[320px] overflow-y-auto pr-1">
              <For each={memories()}>
                {(row) => (
                  <div class="flex items-start justify-between gap-3 rounded-md border border-[var(--nc-border-subtle,rgba(255,255,255,0.08))] px-3 py-2">
                    <div class="flex min-w-0 flex-col gap-0.5">
                      <span class="text-sm leading-snug break-words">{row.text}</span>
                      <span class="text-xs opacity-60">{scopeLabel(row.scope)}</span>
                    </div>
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
      </div>
    </>
  )
}
