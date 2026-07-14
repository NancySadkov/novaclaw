import { createMemo, createSignal, Show, startTransition } from "solid-js"
import { Icon } from "@novaclaw/ui/icon"
import { Spinner } from "@novaclaw/ui/spinner"
import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { useDirectoryPicker } from "@/components/directory-picker"
import { displayName, errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"

// The "New Agent" launch box — the home launcher's primary action, pinned at the BOTTOM of the
// screen (the chat composer's position). CLICKING it creates a session in the shared scratch dir
// (or a folder picked via the chip) and opens the new chat immediately — nothing is typed or
// fired here (owner call 2026-07-14): the user lands in the real composer, configures the chat
// (model, permission mode, Strict, Tuning, prompt override, folder), and sends when ready.
export function NewAgentBar() {
  const server = useServer()
  const global = useGlobal()
  const sync = useServerSync()
  const tabs = useTabs()
  const language = useLanguage()
  const pickDirectory = useDirectoryPicker()

  const conn = createMemo(() => server.current)
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  // Path/config come from the active server's sync — prefer the resolved ctx sync, but fall back to the
  // top-level `useServerSync()` (the current server) so a not-yet-warm ctx never yields an undefined
  // path. Mirrors the proven resolution in home.tsx (`focusedServerCtx()?.sync ?? sync()`).
  const activeSync = () => ctx()?.sync ?? sync()
  // The always-provisioned scratch cwd (server-provided under `<data>/scratch`) — lets a new agent work
  // with no project picked. Read off PathInfo with a cast (the SDK type lags this field).
  const scratchDir = createMemo(() => (activeSync().data.path as { scratchDir?: string } | undefined)?.scratchDir)

  const [targetFolder, setTargetFolder] = createSignal<string | undefined>()
  const [spawning, setSpawning] = createSignal(false)
  const spawnFolder = createMemo(() => targetFolder() ?? scratchDir())
  const canSpawn = createMemo(() => !!conn() && !!spawnFolder())
  const folderLabel = createMemo(() => {
    const folder = targetFolder()
    if (!folder) return language.t("home.newAgent.folder.scratch")
    return displayName({ worktree: folder })
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

  async function spawn() {
    const c = conn()
    const directory = spawnFolder()
    if (!c || !directory || spawning()) return
    setSpawning(true)
    try {
      const cx = global.ensureServerCtx(c)
      const created = await cx.sdk.client.v2.session.create({ location: { directory } })
      const sessionID = created.data?.data.id
      if (created.error || !sessionID) throw created.error ?? new Error("session create returned no id")
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

  // Owner call 2026-07-14: the CLICK creates the chat — no typing here. The bar sits at the
  // bottom of the launcher, the same screen position as the chat composer, so activating it
  // transitions straight into the new chat's composer without the input appearing to move.
  const activate = () => {
    if (spawning()) return
    // Never silently no-op: if the server/scratch dir isn't ready yet, tell the user instead of
    // eating the click (which reads as "nothing happens").
    if (!canSpawn()) {
      showToast({
        title: language.t("common.requestFailed"),
        description: "Still connecting to your workspace — try again in a moment.",
      })
      return
    }
    void spawn()
  }

  return (
    <div
      data-slot="home-new-agent"
      class="flex w-full items-center gap-2 rounded-[12px] bg-v2-background-bg-layer-01 px-3.5 py-3 ring-1 ring-v2-border-border-base transition-shadow focus-within:ring-2 focus-within:ring-[var(--v2-border-border-focus)]"
    >
      <Icon name="edit" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      <input
        data-slot="home-new-agent-input"
        type="text"
        readonly
        class="min-w-0 flex-1 cursor-text bg-transparent text-[14px] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
        placeholder={language.t("home.newAgent.placeholder")}
        disabled={spawning()}
        onPointerDown={(event) => {
          event.preventDefault()
          activate()
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.preventDefault()
          activate()
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
