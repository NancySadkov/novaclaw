import { type Component, createMemo, createSignal, Show } from "solid-js"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { useConfirm } from "@/components/dialog-confirm"
import { RequiresLevel } from "@/context/expertise"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import {
  memoryClearScopeVerified,
  memoryEraseVerified,
  memoryExport,
  memoryIngest,
  memoryRemember,
} from "@/utils/memory-api"
import { buildMemoryBundle, importScope, parseMemoryBundle } from "./memory-bundle"
import { runBackedUpMemoryErase } from "./memory-clear"
import { MemoryRemembered } from "@/components/memory-remembered"
import { SettingsProfileSection } from "./profile"
import { SettingsExplainV2 } from "./explain"
import { instanceGlobalDirectory } from "@/utils/routing-directory"

// The Memory tab — the lay-first home for "what NovaClaw remembers".
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

/**
 * ⚠️ `embedded` renders this WITHOUT the settings-tab header, so the Memory app can host it as a
 * third view beside Remembered and Graph (owner, 2026-08-20: *"we still have Memory tab in the
 * settings, instead of everything migrated to the app"*). One component, two hosts — the alternative
 * was a second copy, and this file already proved where that leads: its duplicate Remembered list
 * silently kept an expertise gate and a missing confirm after the shared one was fixed.
 */
export const SettingsMemoryV2: Component<{ sessionID?: string; embedded?: boolean }> = (props) => {
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
      (serverSync().data.config as { memory?: { enabled?: boolean; embedding?: { url?: string; model?: string } } })
        .memory ?? {},
  )
  const enabled = () => memoryConfig().enabled !== false
  // The VECTOR leg's device (Advanced). Measured: hybrid vector+FTS retrieval 85% vs 77% keyword-only.
  // Unset = keyword-only search, which is a valid configuration, not a broken one. The server reads
  // this live (2s TTL), so pointing at a device takes effect without a restart; blanking a field is
  // "use default" over the patch-merge wire, which the reader treats as unconfigured.
  const embedding = () => memoryConfig().embedding ?? {}

  // What the product already knows: every configured provider's endpoint, and the models each one
  // serves. `TYPED` is a real literal because "" reads as *nothing selected* and blanks the trigger.
  const providers = useProviders()
  const TYPED = "type-it-myself"
  /** Unset is a real, meaningful state here — the section says "Leave blank to match on keywords
   *  only" — so it gets a NAMED option rather than a blank trigger that says nothing. */
  const NONE = "not-configured"
  const endpoints = createMemo(() => {
    const seen = new Set<string>()
    for (const [, provider] of providers.all()) {
      const url = (provider as { api?: { url?: string } }).api?.url
      if (url) seen.add(url)
    }
    return [...seen]
  })
  /** Models served by the CHOSEN endpoint — the pairing the audit asked for. Falls back to the whole
   *  catalog when the endpoint is typed rather than picked, since nothing narrows it then. */
  const embeddingModels = createMemo(() => {
    const url = embedding().url
    const ids: string[] = []
    for (const [providerID, provider] of providers.all()) {
      const providerURL = (provider as { api?: { url?: string } }).api?.url
      if (url && providerURL && providerURL !== url) continue
      for (const model of providers.models(providerID)) ids.push(model.id)
    }
    return [...new Set(ids)]
  })
  // A stored value the catalog does not know is a value the USER typed; keep showing it as text
  // rather than letting a picker quietly drop it.
  const urlIsCustom = () => {
    const url = embedding().url
    return !!url && !endpoints().includes(url)
  }
  const modelIsCustom = () => {
    const model = embedding().model
    return !!model && !embeddingModels().includes(model)
  }
  const [typingURL, setTypingURL] = createSignal(false)
  const [typingModel, setTypingModel] = createSignal(false)
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
    return instanceGlobalDirectory(path)
  }
  const [tick, setTick] = createSignal(0)
  const refresh = () => setTick((t) => t + 1)
  const [busy, setBusy] = createSignal(false)

  const sessionScope = () => (props.sessionID ? `session:${props.sessionID}` : undefined)

  const failed = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("settings.memory.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })

  /** Fetch every memory (valid only) as the backup bundle text; empty string when there's nothing. */
  const collectBundle = async (): Promise<string> => {
    const cn = conn()
    if (!cn) throw new Error("The instance is unavailable")
    const rows = await memoryExport(cn.http, { directory: directory() })
    if (!rows.length) return ""
    return buildMemoryBundle(rows, new Date().toISOString())
  }

  const exportMemory = async () => {
    setBusy(true)
    try {
      const bundle = await collectBundle()
      if (!bundle) {
        showToast({ variant: "default", title: language.t("settings.memory.export.empty") })
        return
      }
      downloadText(BACKUP_FILENAME, bundle)
      showToast({ variant: "success", icon: "circle-check", title: language.t("settings.memory.export.toast") })
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
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
          parsed.error === "version"
            ? "settings.memory.import.invalid.version"
            : "settings.memory.import.invalid.description",
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
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("settings.memory.import.toast", { count: ok }),
    })
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
    setBusy(true)
    try {
      const result = await runBackedUpMemoryErase({
        collect: collectBundle,
        beginBackup: (bundle) => downloadText(BACKUP_FILENAME, bundle),
        erase: () => memoryEraseVerified(cn.http, { directory: directory() }),
      })
      refresh()
      showToast({
        variant: "success",
        icon: "circle-check",
        title:
          result.erased === 0
            ? language.t("settings.memory.clearAll.empty")
            : result.backupStarted
              ? language.t("settings.memory.clearAll.toastBackup", { count: result.erased })
              : language.t("settings.memory.clearAll.toast", { count: result.erased }),
      })
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
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
    const cn = conn()
    if (!cn) return
    setBusy(true)
    try {
      await memoryClearScopeVerified(cn.http, { directory: directory(), scope })
      refresh()
      showToast({ variant: "success", icon: "circle-check", title: language.t("settings.memory.clearChat.toast") })
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Show when={!props.embedded}>
        <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
          <h2 class="settings-v2-tab-title">{language.t("settings.memory.title")}</h2>
          <p class="settings-v2-tab-description">{language.t("settings.memory.description")}</p>
        </div>
      </Show>

      <div class="settings-v2-tab-body">
        <SettingsProfileSection />

        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.memory.enabled.title")}
              description={
                <>
                  {language.t("settings.memory.enabled.description")}
                  <SettingsExplainV2 label={language.t("settings.memory.enabled.title")}>
                    {language.t("settings.memory.enabled.description.more")}
                  </SettingsExplainV2>
                </>
              }
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
                  <Show
                    when={!typingURL() && !urlIsCustom() && endpoints().length > 0}
                    fallback={
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
                    }
                  >
                    <SelectV2
                      appearance="inline"
                      data-action="settings-memory-embedding-url"
                      options={[
                        { value: NONE, label: language.t("settings.memory.embedding.none") },
                        ...endpoints().map((url) => ({ value: url, label: url })),
                        { value: TYPED, label: language.t("settings.memory.embedding.typed") },
                      ]}
                      current={
                        embedding().url
                          ? { value: embedding().url!, label: embedding().url! }
                          : { value: NONE, label: language.t("settings.memory.embedding.none") }
                      }
                      placement="bottom-end"
                      gutter={6}
                      value={(o) => o.value}
                      label={(o) => o.label}
                      onSelect={(option) => {
                        if (!option) return
                        if (option.value === TYPED) return setTypingURL(true)
                        persistEmbedding({ url: option.value === NONE ? "" : option.value })
                      }}
                    />
                  </Show>
                </div>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.memory.embedding.model.title")}
                description={language.t("settings.memory.embedding.model.description")}
              >
                <div class="w-full sm:w-[260px]">
                  <Show
                    when={!typingModel() && !modelIsCustom() && embeddingModels().length > 0}
                    fallback={
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
                    }
                  >
                    <SelectV2
                      appearance="inline"
                      data-action="settings-memory-embedding-model"
                      options={[
                        { value: NONE, label: language.t("settings.memory.embedding.none") },
                        ...embeddingModels().map((id) => ({ value: id, label: id })),
                        { value: TYPED, label: language.t("settings.memory.embedding.typed") },
                      ]}
                      current={
                        embedding().model
                          ? { value: embedding().model!, label: embedding().model! }
                          : { value: NONE, label: language.t("settings.memory.embedding.none") }
                      }
                      placement="bottom-end"
                      gutter={6}
                      value={(o) => o.value}
                      label={(o) => o.label}
                      onSelect={(option) => {
                        if (!option) return
                        if (option.value === TYPED) return setTypingModel(true)
                        persistEmbedding({ model: option.value === NONE ? "" : option.value })
                      }}
                    />
                  </Show>
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
          {/* 🔴 The SHARED list, not a second copy of it (2026-08-20). This tab used to re-implement
            the whole Remembered list — the same rows, its own `forget`, and its own
            `RequiresLevel min="advanced"` gate. That duplication went wrong exactly as duplication
            does: when the owner reported the Memory APP had "no way to remove memories", the fix
            (drop the expertise gate, confirm before deleting) landed on the shared component and
            this copy kept the gate AND kept deleting on a single click with no confirmation. Two
            surfaces disagreeing about who may erase a memory is worse than either answer. */}
          <MemoryRemembered
            class="settings-v2-section"
            {...(props.sessionID === undefined ? {} : { sessionID: props.sessionID })}
            revision={tick()}
          />
        </div>
      </div>
    </>
  )
}
