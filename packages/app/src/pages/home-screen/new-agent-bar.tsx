import { createMemo, createSignal, Show, startTransition } from "solid-js"
import { SessionTitle } from "@novaclaw/core/session/title"
import { Icon } from "@novaclaw/ui/v2/icon"
import { Spinner } from "@novaclaw/ui/spinner"
import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"
import type { AgentLike } from "@/apps/contacts"
import { roster } from "@/apps/contacts"
import { AgentV2 } from "@novaclaw/core/agent"

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

  // 🔴 Takes a COLLEAGUE, not a folder (owner, 2026-08-21). The server resolves where that colleague
  // works — its configured project, or its own scratch — so the client never joins a scratch path
  // itself, and "which folder does this chat run in" stops being a question the user answers twice.
  //
  // ⚠️ The reuse probe below still needs a directory, so it is read from the roster row the caller
  // already holds rather than re-derived: the client knows where the colleague works because the bar
  // had to resolve it to open their chat in the first place.
  async function spawn(agentID?: string, agentFolder?: string, agentName?: string) {
    /** The colleague's name, falling back to their id so a chat is never titled `undefined`. */
    const agentTitle = (id: string) => agentName?.trim() || id
    const c = conn()
    // 🔴 `agentFolder` is WHERE THIS COLLEAGUE WORKS — its configured project, or its own
    // `<data>/scratch/<agentID>` workspace as the SERVER derives it (`AgentWorkspace.folderFor`),
    // resolved by the caller off the roster row it already holds. Only a spawn with NO colleague
    // falls through to the shared scratch root. It used to fall through whenever a colleague merely
    // had no project — the ordinary state of a fresh hire (review D4, 2026-08-23) — so the reuse
    // probe searched a folder the colleague's chats are never filed in, and `projects.open()`
    // registered the shared root while the session lived one directory down.
    const directory = agentFolder ?? scratchDir()
    if (!c || !directory || spawning()) return
    setSpawning(true)
    try {
      const cx = global.ensureServerCtx(c)
      // Anti-litter (issues.md P3): the click-creates-chat UX stays (owner call 2026-07-14),
      // but a NEVER-USED chat in the target folder (default title, zero tokens) is REOPENED
      // instead of minting a sibling — five stray clicks land in one chat, not five rows.
      // The loaded list is best-effort: an unloaded store just falls through to create.
      const [childStore] = cx.sync.peek(directory, { bootstrap: false })
      // ⚠️ `s.agent === agentID` is load-bearing, and it was the half that was missing. The other
      // four clauses say "an untouched chat in this folder" and none of them mentions WHO it
      // belongs to — so one stray agent-less draft in the shared root was reopened for whichever
      // colleague the chip had selected, forever. A chat may only ever be reused for its own
      // colleague.
      const reusable = childStore.session.find(
        (s) =>
          !s.parentID &&
          (s.agent ?? undefined) === agentID &&
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
            const tab = tabs.addSessionTab({ server: ServerConnection.key(c), sessionId: reusable.id, agent: agentID })
            tabs.select(tab)
          })
          return
        }
      }
      // No `location`: the server resolves the colleague's own folder (`agentLocation`), which is the
      // ONE place that rule lives. Sending a directory computed here would be a second copy of it.
      //
      // 🔴 **A colleague's chat is titled with the colleague's NAME.** Owner, 2026-08-24: *"we still
      // have 'New session', instead of the agent's name for the session title."* Contacts already
      // titled it (`startChat({ agentID, title: name })`); this door did not — and because one chat
      // per agent means BOTH doors reach the same chat, whichever opened it first decided the title.
      // Open a colleague from the launcher and their chat was called "New session" forever after.
      const created = await cx.sdk.client.v2.session.create(
        agentID ? ({ agent: agentID, title: agentTitle(agentID) } as never) : { location: { directory } },
      )
      const sessionID = created.data?.data.id
      if (created.error || !sessionID) throw created.error ?? new Error("session create returned no id")
      cx.projects.open(directory)
      cx.projects.touch(directory)
      startTransition(() => {
        // `agent` so the store can switch to this colleague's open tab instead of adding a second
        // one — the launcher is one of the two doors the owner watched duplicate a chat.
        const tab = tabs.addSessionTab({ server: ServerConnection.key(c), sessionId: sessionID, agent: agentID })
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
  const agent = useNewAgentSpawn()

  const global = useGlobal()
  // ⚠️ The SAME definition of "the current server" as `system-load.ts`, `contacts.tsx` and
  // `officer-settings-screen.tsx` (review H8). With a bare `server.current` the hero tile beside this
  // bar happily polled the first server while the bar reported "Still connecting to your
  // workspace" — two answers to one question, on one screen.
  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const barCtx = createMemo(() => {
    const current = conn()
    return current ? global.ensureServerCtx(current) : undefined
  })
  const spawning = agent.spawning
  // The server context's ONE shared roster (review D8), which also carries the `.catch` this
  // call site was missing (D1/H1). It matters most here: this component is mounted unconditionally
  // by the home screen, which is the app's BOOT ROUTE, and a rejected resource read from the eager
  // memo below reached the root ErrorBoundary and replaced the launcher with the error page.
  const agents = () => barCtx()?.agents.list()
  const agentsLoading = () => barCtx()?.agents.loading() ?? true
  // The roster, as the bar needs it: who they are, and where each one works. `folderFor` is resolved
  // here ONLY for the reuse probe - the session's actual folder is decided by the server, so the two
  // can never disagree about a colleague the client has not re-read.
  const agentOptions = createMemo(() =>
    roster(agents() ?? []).map((view) => {
      const row = (agents() ?? []).find((item: AgentLike) => item.id === view.id)
      const shortChat = row?.config?.["shortChat"] === true
      const configured = shortChat ? undefined : row?.config?.["directory"]
      const folder = typeof configured === "string" && configured.trim() !== "" ? configured : undefined
      return {
        id: view.id,
        name: view.name,
        avatar: view.avatar,
        folder: folder ?? language.t("agentConfig.folderScratch"),
        ownScratch: folder === undefined,
        shortChat,
      }
    }),
  )
  /**
   * ONE FRONT DOOR, AND IT IS NOVA (owner, 2026-09-27: *"make the text `Ask Nova anything...`, and
   * make it always send to Nova"*).
   *
   * This used to be a DEFAULT - `chosenAgent() ?? defaultOfficerID()` - with a chip beside it, so
   * every click was a small decision the user had to make and the placeholder did not say who would
   * answer. The selector is gone; the label names the one destination.
   *
   * It already landed on Nova, but only because `roster()` sorts the governing agent first - so the
   * earlier ruling was satisfied by a SORT ORDER, and any change to that ordering would have moved
   * the default silently, with nothing to notice. This asks by NAME, which cannot drift.
   *
   * Falls back to the first officer rather than to nothing, and that is a FAULT path rather than a
   * feature: Nova is `isProtected` and can never be retired, so a roster without one is a roster that
   * is not answering, and a working launcher on the wrong officer beats one that reports success and
   * opens nothing. It can never fall back to a posture - `roster()` excludes them, which is what the
   * retirement of the anonymous agents enforced.
   */
  const defaultOfficerID = () =>
    agentOptions().find((option) => option.id === AgentV2.DEFAULT_COLLEAGUE_ID)?.id ?? agentOptions()[0]?.id
  /**
   * The officer this bar always opens, and the WORDS the placeholder speaks.
   *
   * ⚠️ The name comes from the roster row, NOT from the id, and that is the whole reason this memo
   * exists rather than `defaultOfficerID()` alone. The id is `nova` — lowercase, and a fixed string:
   * a user who renamed their CEO would read "Ask nova anything..." forever, which is both ugly and a
   * lie about who answers. The roster carries the name the owner actually gave them, so the bar
   * greets them by it. Probed: with `name: "Nova"` this renders "Ask Nova anything...", and with
   * `name: "Wren"` it renders "Ask Wren anything...".
   *
   * The id is the fallback, and the constant behind that, so the label can never render the literal
   * `{{name}}` — `resolveTranslation` leaves an unfilled placeholder in place rather than blanking it,
   * which is the right behaviour for a miss elsewhere and would be a visible bug here.
   */
  const officer = createMemo(() => {
    const id = defaultOfficerID()
    const shown = agentOptions().find((option) => option.id === id)?.name?.trim()
    return { id, name: shown || id || AgentV2.DEFAULT_COLLEAGUE_ID }
  })
  const chosenFolder = () => {
    const id = officer().id
    if (id === undefined) return undefined
    const row = (agents() ?? []).find((entry: AgentLike) => entry.id === id)
    const configured = row?.config?.["shortChat"] === true ? undefined : row?.config?.["directory"]
    if (typeof configured === "string" && configured.trim() !== "") return configured
    // Then the colleague's OWN workspace, read off the roster row rather than joined here:
    // `Scratch.forAgent` lives in `core` behind `node:path` + `Global.Path.data`, so the client
    // cannot compute it, and a second copy of that rule is how the client and the server end up
    // disagreeing about where a chat lives. The roster response stamps it (`agent-list.ts:53`).
    const workspace = row?.workspace?.trim()
    return workspace ? workspace : undefined
  }
  const canSpawn = createMemo(() => (chosenFolder() ? !!conn() : agent.ready()))
  // Owner call 2026-07-14: the CLICK creates the chat - no typing here. The bar sits at the
  // bottom of the launcher, the same screen position as the chat composer, so activating it
  // transitions straight into the new chat's composer without the input appearing to move.
  const activate = () => {
    if (spawning()) return
    // A click while the ROSTER is still in flight used to spawn `spawn(undefined, undefined)` -
    // an agent-less chat in the shared scratch root, which then sat there as the thing every later
    // click reused (review D4). The click must create a named colleague's chat or nothing.
    //
    // The "degraded instance keeps its escape hatch" clause is GONE (owner, 2026-08-28:
    // "Clicking `Start new chat` at home creates a ghost session `New session in scratch` - that
    // shouldn't be possible at all, since can't have sessions without any agents"). A settled roster
    // with nobody in it used to fall through here on purpose. It is not an escape hatch: it is the
    // one input that can mint an ownerless chat, and it fired exactly when the instance was already
    // broken - so the app answered a fault by creating a session that belongs to no one and that no
    // roster can ever show. An empty roster is a FAULT at the source (`apps/agent-list.ts`), and this
    // refuses rather than papering over it.
    if (agentsLoading()) {
      showToast({
        title: language.t("common.requestFailed"),
        description: language.t("home.newAgent.notReady"),
      })
      return
    }
    // Never silently no-op: if the server/scratch dir isn't ready yet, tell the user instead of
    // eating the click (which reads as "nothing happens").
    if (!canSpawn()) {
      showToast({
        title: language.t("common.requestFailed"),
        description: language.t("home.newAgent.notReady"),
      })
      return
    }
    const id = officer().id
    if (id === undefined) {
      // Says WHICH fact is wrong - that Nova cannot be missing - rather than "not ready", which
      // invites the user to wait for something that is never going to arrive.
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: language.t("home.newAgent.noColleagues"),
      })
      return
    }
    void agent.spawn(id, chosenFolder(), officer().name)
  }
  return (
    <div
      data-slot="home-new-agent"
      class="flex w-full items-center gap-2 rounded-[8px] bg-v2-background-bg-layer-01 px-3.5 py-3 ring-1 ring-v2-border-border-base transition-shadow focus-within:ring-2 focus-within:ring-[var(--v2-border-border-focus)]"
    >
      {/* Gold lead-in glyph - the skin's command bar opens with a gold mark (one accent, spent on
          the primary action; the hero + this bar are the home screen's two gold anchors). */}
      <Icon name="edit" size="normal" class="shrink-0 text-v2-icon-icon-accent" />
      {/* A BUTTON, because that is what it does (review H7). It used to be a readOnly text input with
          preventDefault() on pointerdown: a screen reader announced a text field the user could not
          type into, the preventDefault suppressed focus so a mouse user never focused the control they
          had just activated, and the Enter handler only ever reached people who tabbed to it. Nothing
          is typed here - the click creates the chat and the real composer is where words go (owner
          call 2026-07-14) - so the element says so. The input's look is kept verbatim; only the
          semantics changed. */}
      <button
        data-slot="home-new-agent-input"
        type="button"
        class="min-w-0 flex-1 cursor-pointer bg-transparent text-left text-[14px] text-v2-text-text-faint outline-none disabled:opacity-60"
        disabled={spawning()}
        onClick={() => activate()}
      >
        {language.t("home.newAgent.placeholder", { name: officer().name })}
      </button>
      <Show when={spawning()}>
        <Spinner class="size-4 shrink-0 text-v2-icon-icon-muted" />
      </Show>
      {/* NO OFFICER SELECTOR, and the words beside this glyph now say who (owner, 2026-09-27). The
          chip that stood here asked WHICH officer to open, on a bar whose only action is to open
          Nova's chat - so it made the common case a decision and hid the fact that there was a
          default at all. One front door, named in the words on it. */}
    </div>
  )
}
