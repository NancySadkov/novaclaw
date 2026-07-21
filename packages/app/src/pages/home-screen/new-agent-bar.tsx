import { createMemo, createSignal, Show, startTransition } from "solid-js"
import { SessionTitle } from "@novaclaw/core/session/title"
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

/**
 * The shared "spawn a new agent chat" flow: create (or reuse a truly-empty draft) in the given
 * folder — default the always-provisioned scratch dir — and open the chat. Consumed by the home
 * launcher bar AND the Chats-page "New chat" header button (owner 2026-07-22: creating a chat
 * must never require routing back to the launcher).
 */
export function useNewAgentSpawn() {
  const server = useServer()
  const global = useGlobal()
  const sync = useServerSync()
  const tabs = useTabs()
  const language = useLanguage()

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

  const [spawning, setSpawning] = createSignal(false)

  async function spawn(target?: string) {
    const c = conn()
    const directory = target ?? scratchDir()
    if (!c || !directory || spawning()) return
    setSpawning(true)
    try {
      const cx = global.ensureServerCtx(c)
      // Anti-litter (issues.md P3): the click-creates-chat UX stays (owner call 2026-07-14),
      // but a NEVER-USED chat in the target folder (default title, zero tokens) is REOPENED
      // instead of minting a sibling — five stray clicks land in one chat, not five rows.
      // The loaded list is best-effort: an unloaded store just falls through to create.
      const [childStore] = cx.sync.peek(directory, { bootstrap: false })
      const reusable = childStore.session.find(
        (s) =>
          !s.parentID &&
          s.location.directory === directory &&
          SessionTitle.isDefault(s.title) &&
          (s.tokens?.input ?? 0) + (s.tokens?.output ?? 0) === 0,
      )
      if (reusable) {
        // Server truth before reusing: title/tokens alone LIE for a chat whose sent message
        // never produced a reply (turn failed → zero tokens, auto-title never ran) — reusing
        // it opens an old conversation as "new" (owner-hit 2026-07-22). One 1-message page
        // decides; on fetch error fall through to CREATE (never trap the user in an old chat).
        const empty = await cx.sdk.client.v2.session
          .messages({ sessionID: reusable.id, limit: 1 })
          .then((result) => (result.data?.data ?? []).length === 0)
          .catch(() => false)
        if (empty) {
          startTransition(() => {
            const tab = tabs.addSessionTab({ server: ServerConnection.key(c), sessionId: reusable.id })
            tabs.select(tab)
          })
          return
        }
      }
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

  return {
    spawning,
    ready: createMemo(() => !!conn() && !!scratchDir()),
    spawn,
  }
}

// The "New Agent" launch box — the home launcher's primary action, pinned at the BOTTOM of the
// screen (the chat composer's position). CLICKING it creates a session in the shared scratch dir
// (or a folder picked via the chip) and opens the new chat immediately — nothing is typed or
// fired here (owner call 2026-07-14): the user lands in the real composer, configures the chat
// (model, permission mode, Strict, Tuning, prompt override, folder), and sends when ready.
export function NewAgentBar() {
  const server = useServer()
  const language = useLanguage()
  const pickDirectory = useDirectoryPicker()
  const agent = useNewAgentSpawn()

  const conn = createMemo(() => server.current)
  const spawning = agent.spawning
  const [targetFolder, setTargetFolder] = createSignal<string | undefined>()
  const canSpawn = createMemo(() => (targetFolder() ? !!conn() : agent.ready()))
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
    void agent.spawn(targetFolder())
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
