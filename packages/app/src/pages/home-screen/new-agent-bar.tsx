import { createMemo, createSignal, Show, startTransition } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { Spinner } from "@novaclaw/ui/spinner"
import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useModels } from "@/context/models"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { useDirectoryPicker } from "@/components/directory-picker"
import { displayName, errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"

// The "New Agent" spawn box — the home launcher's primary action. Type a prompt, hit Enter: it creates
// a session in the shared scratch dir (or a folder picked via the chip), fires the prompt, and opens the
// new chat — no draft/composer detour. Self-contained: it resolves the current server, its scratch dir,
// and the model to use on its own, so it can live on the launcher without the Chats page's contexts.
// (Moved off /chats: the Chats page is now a pure list of existing chats.)
export function NewAgentBar() {
  const server = useServer()
  const global = useGlobal()
  const models = useModels()
  const tabs = useTabs()
  const language = useLanguage()
  const pickDirectory = useDirectoryPicker()

  const conn = createMemo(() => server.current)
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  // The always-provisioned scratch cwd (server-provided under `<data>/scratch`) — lets a new agent work
  // with no project picked. Read off PathInfo with a cast (the SDK type lags this field).
  const scratchDir = createMemo(() => (ctx()?.sync.data.path as { scratchDir?: string } | undefined)?.scratchDir)

  const [targetFolder, setTargetFolder] = createSignal<string | undefined>()
  const [spawning, setSpawning] = createSignal(false)
  const spawnFolder = createMemo(() => targetFolder() ?? scratchDir())
  const canSpawn = createMemo(() => !!conn() && !!spawnFolder())
  const folderLabel = createMemo(() => {
    const folder = targetFolder()
    if (!folder) return language.t("home.newAgent.folder.scratch")
    return displayName({ worktree: folder })
  })

  // The spawn turn must carry an explicit model (a model-less turn regresses to the legacy path).
  // Prefer the user's living choices: last-used → curated "shown" → config default → first available.
  const spawnModel = createMemo(() => {
    const usable = (key: { providerID: string; modelID: string }) => !!models.find(key) && models.visible(key)
    const recent = models.recent.list().find(usable)
    if (recent) return { providerID: recent.providerID, modelID: recent.modelID }
    const shown = models.shown()[0]
    if (shown) return { providerID: shown.providerID, modelID: shown.modelID }
    const configured = (ctx()?.sync.data.config as { model?: string } | undefined)?.model
    if (configured) {
      const [providerID, ...rest] = configured.split("/")
      if (providerID && rest.length) {
        const key = { providerID, modelID: rest.join("/") }
        if (usable(key)) return key
      }
    }
    const first = models.list().find((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
    return first ? { providerID: first.provider.id, modelID: first.id } : undefined
  })

  function pickFolder() {
    const c = conn()
    if (!c) return
    pickDirectory({
      server: c,
      title: language.t("command.project.open"),
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) setTargetFolder(directory)
      },
    })
  }

  async function spawn(prompt: string) {
    const text = prompt.trim()
    const c = conn()
    const directory = spawnFolder()
    if (!text || !c || !directory || spawning()) return
    setSpawning(true)
    try {
      const cx = global.ensureServerCtx(c)
      const created = await cx.sdk.client.v2.session.create({ location: { directory } })
      const sessionID = created.data?.data.id
      if (created.error || !sessionID) throw created.error ?? new Error("session create returned no id")
      const admitted = await cx.sdk.client.session.promptAsync({
        sessionID,
        model: spawnModel(),
        parts: [{ type: "text", text }],
      })
      if (admitted.error) throw admitted.error
      cx.projects.open(directory)
      cx.projects.touch(directory)
      startTransition(() => {
        const tab = tabs.addSessionTab({ server: ServerConnection.key(c), sessionId: sessionID })
        tabs.select(tab)
      })
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      setSpawning(false)
    }
  }

  const [value, setValue] = createSignal("")
  const submit = () => {
    const text = value().trim()
    if (!text || !canSpawn() || spawning()) return
    void spawn(text)
    setValue("")
  }

  // The input stays enabled (only locked mid-spawn) so it's always clickable/typeable; submit is gated
  // on `canSpawn` — a keystroke before the scratch dir has loaded just no-ops instead of dead-ending.
  return (
    <div
      data-slot="home-new-agent"
      class="flex w-full items-center gap-2 rounded-[12px] bg-v2-background-bg-layer-01 px-3.5 py-3 ring-1 ring-v2-border-border-base transition-shadow focus-within:ring-2 focus-within:ring-[var(--v2-border-border-focus)]"
    >
      <Icon name="edit" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      <input
        data-slot="home-new-agent-input"
        type="text"
        class="min-w-0 flex-1 bg-transparent text-[14px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
        placeholder={language.t("home.newAgent.placeholder")}
        disabled={spawning()}
        value={value()}
        onInput={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.preventDefault()
          submit()
        }}
      />
      <Show when={spawning()}>
        <Spinner class="size-4 shrink-0 text-v2-icon-icon-muted" />
      </Show>
      <button
        type="button"
        data-slot="home-new-agent-folder"
        class="flex shrink-0 items-center gap-1 rounded-full bg-v2-background-bg-layer-02 px-2 py-1 text-[11px] leading-none text-v2-text-text-muted transition-colors hover:text-v2-text-text-base"
        title={language.t("home.newAgent.folder.pick")}
        onClick={pickFolder}
      >
        <Icon name="folder" size="small" />
        {folderLabel()}
      </button>
      <Show when={targetFolder() !== undefined}>
        <button
          type="button"
          aria-label={language.t("home.newAgent.folder.reset")}
          class="shrink-0 text-[13px] leading-none text-v2-text-text-faint hover:text-v2-text-text-base"
          onClick={() => setTargetFolder(undefined)}
        >
          ×
        </button>
      </Show>
    </div>
  )
}
