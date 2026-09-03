import { createSimpleContext } from "@novaclaw/ui/context"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted, removePersisted, draftPersistedKeys } from "@/utils/persist"
import { ServerConnection, useServer } from "./server"
import { createEffect, createSignal, getOwner, onCleanup, startTransition } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { usePlatform } from "./platform"
import { uuid } from "@/utils/uuid"
import { SessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { sessionHref } from "@/utils/session-route"
import { createTabMemory } from "./tab-memory"
import { findAgentTab } from "./tab-agent"

export type SessionTab = {
  type: "session"
  server: ServerConnection.Key
  sessionId: string
  /**
   * Which colleague this chat belongs to — the key the ONE-TAB-PER-COLLEAGUE invariant is enforced
   * on. Optional because a tab persisted before this field existed, or a chat with no colleague at
   * all, still has to work: `undefined` simply opts that tab out of the invariant rather than
   * colliding every anonymous chat into one tab.
   */
  agent?: string
}

export type DraftTab = {
  type: "draft"
  draftID: string
  server: ServerConnection.Key
  directory: string
  worktree?: string
}

export type Tab = SessionTab | DraftTab

type RecentTab = {
  key?: string
  /**
   * Task keys in interaction order, most recent FIRST. Optional so an existing stored `{ key }`
   * keeps working and simply starts empty.
   */
  keys?: string[]
}

/** How much history to keep. The strip asks for the first few; the rest is only ever a tiebreak. */
const RECENT_LIMIT = 24

export const draftHref = (draftID: string) => `/new-session?draftId=${encodeURIComponent(draftID)}`

export const tabHref = (tab: Tab) =>
  tab.type === "draft" ? draftHref(tab.draftID) : sessionHref(tab.server, tab.sessionId)

export const tabKey = (tab: Tab) => (tab.type === "draft" ? `draft:${tab.draftID}` : `${tab.server}\n${tabHref(tab)}`)

export const {
  use: useTabs,
  provider: TabsProvider,
  context: TabsContext,
} = createSimpleContext({
  name: "Tabs",
  gate: false,
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const fallback = server.key
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("tabs"),
        migrate: (value: unknown) => {
          if (!Array.isArray(value)) return value
          return value.map((tab) => {
            if (!tab || typeof tab !== "object" || "server" in tab) return tab
            return { ...tab, server: fallback }
          })
        },
      },
      createStore<Tab[]>([]),
    )
    const [recent, setRecent, , recentReady] = persisted(Persist.global("tabs.recent"), createStore<RecentTab>({}))

    const params = useParams()
    const navigate = useNavigate()
    const location = useLocation()
    const memory = createTabMemory(getOwner())

    let recentWrite = 0
    let recentValue: string | undefined

    const recentKey = () => (recentWrite ? recentValue : recent.key)

    /** Most-recent-first, with `key` promoted and duplicates dropped. Pure so the order is testable. */
    const promote = (keys: readonly string[] | undefined, key: string | undefined) =>
      key === undefined
        ? [...(keys ?? [])]
        : [key, ...(keys ?? []).filter((item) => item !== key)].slice(0, RECENT_LIMIT)

    const setRecentKey = (key: string | undefined) => {
      const write = ++recentWrite
      recentValue = key
      const apply = () => {
        setRecent("key", key)
        // Only a REAL selection reorders history. `undefined` means "the task you were on is gone",
        // which must not silently reshuffle what the strip shows next.
        if (key !== undefined) setRecent("keys", promote(recent.keys, key))
      }
      if (recentReady()) {
        apply()
        return
      }
      void recentReady.promise?.then(() => {
        if (write === recentWrite) apply()
      })
    }

    const removeDraftPersisted = (draftID: string) => {
      for (const key of draftPersistedKeys()) removePersisted(Persist.draft(draftID, key), platform)
    }

    onCleanup(memory.dispose)

    createEffect(() => {
      if (!ready() || !recentReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = store.filter((tab) => servers.has(tab.server))
      if (next.length !== store.length) {
        for (const tab of store) {
          if (!servers.has(tab.server)) memory.remove(tabKey(tab))
        }
        setStore(() => next)
      }
      if (recent.key && !next.some((tab) => tabKey(tab) === recent.key)) setRecentKey(undefined)
    })

    const navigateTab = (tab: Tab) => {
      const href = tabHref(tab)
      setRecentKey(tabKey(tab))
      navigate(href)
    }

    /**
     * The tab the user just closed on purpose, until the route leaves it.
     *
     * Read by the route effect that opens a tab for the current URL: that effect exists so a deep
     * link, Contacts or a restored window all end up with a tab, and it cannot otherwise distinguish
     * those from a dismissal it is about to undo.
     */
    const [dismissedKey, setDismissedKey] = createSignal<string | undefined>(undefined)

    /**
     * @param stay Take the tab out of the strip and go NOWHERE.
     *
     * 🔴 The navigation below belongs to the CLOSE BUTTON — a user who shut a tab wants to land
     * somewhere, and Home is the honest answer when nothing is left. It does NOT belong to
     * reconciliation. `removeSessionTab` reaches here because the route discovered the chat is gone,
     * and that route has a `SessionGoneCard` built for exactly this state — *"a normal lifecycle
     * event in a multi-client OS, never a crash"* — with its own button to Home. Navigating on its
     * behalf replaces that explanation with a silent jump to Home, which is the dead-end AGENTS.md
     * forbids wearing a redirect's clothes. Let the card say what happened and let the user choose
     * (owner, 2026-09-01: *"the app ends up on Home"*).
     */
    const removeTab = (index: number, stay = false) => {
      const tab = store[index]
      if (!tab) return
      const key = tabKey(tab)
      // 🔴 A CLOSE IS AN INTENT, and until this signal existed nothing recorded it — so the route
      // effect that opens a tab for the URL you are on could not tell "you arrived here" from "you
      // just shut this".
      //
      // Measured 2026-09-03: closing the only tab put it straight back. `titlebar.tsx`'s effect reads
      // the tab store through `matchRoute`, so REMOVING the tab is itself the change that re-runs it;
      // the navigation away is deferred inside the transition below, so the route is still the
      // session, and it re-adds what was just closed. Intermittent, because it is a race with that
      // navigation — which is exactly how it was reported.
      //
      // ⚠️ Only a DISMISSAL sets it. `stay` is reconciliation (the chat is gone and the route wants
      // to explain that itself), and marking those would suppress a legitimate re-open.
      if (!stay) setDismissedKey(key)
      const draftID = tab.type === "draft" ? tab.draftID : undefined
      const nextTab = store[index + 1] ?? store[index - 1]
      void startTransition(() => {
        setStore(
          produce((tabs) => {
            tabs.splice(index, 1)
          }),
        )
        if (recent.key === key) setRecentKey(nextTab && tabKey(nextTab))
        if (stay) return
        if (nextTab) navigateTab(nextTab)
        else navigate("/")
      })
      memory.remove(key)
      if (draftID) removeDraftPersisted(draftID)
    }

    const agentTab = (server: ServerConnection.Key, agent: string | undefined, exceptSession?: string) =>
      findAgentTab(store, server, agent, exceptSession)

    /** Record the colleague on a tab that did not know it yet — never a rename, only a fill-in. */
    const learnAgent = (sessionId: string, server: ServerConnection.Key, agent: string) => {
      setStore(
        produce((tabs) => {
          const tab = tabs.find(
            (item) => item.type === "session" && item.server === server && item.sessionId === sessionId,
          )
          if (tab?.type === "session" && tab.agent === undefined) tab.agent = agent
        }),
      )
    }

    const actions = {
      /**
       * Open a chat's tab — or hand back the one already standing in for its colleague.
       *
       * The RETURN VALUE is load-bearing: callers navigate to what this gives them, so returning an
       * existing tab is how "switch to it" happens rather than "open another". A caller that ignored
       * the result and navigated to its own session id would put the route and the strip on two
       * different chats, which is the defect this exists to prevent.
       */
      addSessionTab: (tab: Omit<SessionTab, "type">) => {
        const next = { type: "session" as const, ...tab }
        const existing = store.find((item) => tabKey(item) === tabKey(next))
        if (existing) {
          // Same chat, and we may now know something about it that we did not before.
          if (next.agent !== undefined) learnAgent(next.sessionId, next.server, next.agent)
          return existing
        }
        const open = agentTab(next.server, next.agent)
        if (open >= 0) return store[open]!
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => tabKey(item) === tabKey(next))) return
              // Re-checked INSIDE the transition: two opens of the same colleague can land in one
              // batch, and the guard above read a store that the first of them had not yet updated.
              if (
                next.agent !== undefined &&
                tabs.some((item) => item.type === "session" && item.server === next.server && item.agent === next.agent)
              )
                return
              tabs.push(next)
            }),
          )
        })
        return next
      },
      /**
       * A tab's session resolved and named its colleague — fill it in, and collapse the tab if that
       * colleague already has one.
       *
       * ⚠️ This is the half of the invariant that handles tabs the app did NOT just open: the strip
       * is restored from disk, so a store persisted while the rule did not exist (or written by an
       * older build) loads already violating it. Enforcing only on the way in would leave those
       * duplicates on screen forever, which is precisely the state the owner reported.
       */
      noteSessionAgent: (server: ServerConnection.Key, sessionId: string, agent: string | undefined) => {
        if (agent === undefined) return
        const index = store.findIndex(
          (tab) => tab.type === "session" && tab.server === server && tab.sessionId === sessionId,
        )
        const tab = store[index]
        if (!tab || tab.type !== "session") return
        const keeperIndex = agentTab(server, agent, sessionId)
        if (keeperIndex >= 0) {
          const keeper = store[keeperIndex]!
          // Was the user LOOKING at the tab about to disappear? Then send them to the survivor
          // rather than to whichever tab happens to sit next to it.
          const watching = recentKey() === tabKey(tab) || location.pathname === tabHref(tab)
          removeTab(index)
          if (watching) navigateTab(keeper)
          return
        }
        if (tab.agent === agent) return
        learnAgent(sessionId, server, agent)
      },
      reorder(keys: string[]) {
        setStore(
          produce((tabs) => {
            const byKey = new Map(tabs.map((tab) => [tabKey(tab), tab]))
            const next = keys.map((key) => byKey.get(key)).filter((tab): tab is Tab => !!tab)
            if (next.length !== tabs.length) return
            tabs.splice(0, tabs.length, ...next)
          }),
        )
      },
      draft(draftID: string) {
        const tab = store.find((item) => item.type === "draft" && item.draftID === draftID)
        if (!tab || tab.type !== "draft") throw new Error(`Draft not found: ${draftID}`)
        return tab
      },
      newDraft(draft: Omit<DraftTab, "type" | "draftID">, prompt?: string) {
        const draftID = uuid()
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              tabs.push({ type: "draft", draftID, ...draft })
            }),
          )
          navigate(prompt ? `${draftHref(draftID)}&prompt=${encodeURIComponent(prompt)}` : draftHref(draftID))
        })
      },
      updateDraft(draftID: string, draft: Partial<Omit<DraftTab, "type" | "draftID">>) {
        void startTransition(() => {
          setStore(
            (tab) => tab.type === "draft" && tab.draftID === draftID,
            produce((tab) => Object.assign(tab, draft)),
          )
        })
      },
      promoteDraft(draftID: string, session: Omit<SessionTab, "type">) {
        // Keep the replacement and navigation atomic so /new-session never renders
        // after its backing draft tab has been removed from the store.
        const active = location.pathname === "/new-session" && location.query.draftId === draftID
        const next = { type: "session" as const, ...session }
        /**
         * 🔴 The same invariant, at the OTHER door (swept 2026-08-28). Promotion replaced the draft
         * tab with a session tab and never asked whether that chat was already open — and it usually
         * is: the server returns a colleague's existing chat rather than making a second one, so
         * sending the first message from a draft produced a duplicate tab of a chat already in the
         * strip. Fold the draft away and go to the tab that was already there.
         */
        const sameChat = store.findIndex(
          (item) => item.type === "session" && item.server === next.server && item.sessionId === next.sessionId,
        )
        const index = sameChat >= 0 ? sameChat : findAgentTab(store, next.server, next.agent)
        const duplicate = store[index]
        if (duplicate) {
          void startTransition(() => {
            setStore(
              produce((tabs) => {
                const index = tabs.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
                if (index !== -1) tabs.splice(index, 1)
              }),
            )
            if (active || recent.key === `draft:${draftID}`) navigateTab(duplicate)
          })
          memory.remove(`draft:${draftID}`)
          removeDraftPersisted(draftID)
          return
        }
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const index = tabs.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
              if (index !== -1) tabs[index] = next
            }),
          )
          if (recent.key === `draft:${draftID}`) setRecentKey(tabKey(next))
          if (active) navigateTab(next)
        })
        memory.remove(`draft:${draftID}`)
        removeDraftPersisted(draftID)
      },
      removeTab,
      /** The key of a tab the user just dismissed, or `undefined`. See `dismissedKey`. */
      dismissedKey,
      /** The route moved somewhere else, so the dismissal no longer needs suppressing. */
      clearDismissed: () => setDismissedKey(undefined),
      /**
       * The chat is GONE — close whatever tab still shows it.
       *
       * 🔴 **The tab strip is a second answer to "which chats exist", and nothing was reconciling it**
       * (owner, 2026-08-28: *"clearing chat doesn't clear the currently opened chat in the app — the
       * messages are still rendered in the UI, until the user closes that chat"*). Clearing archives
       * the session, and the roster updates immediately; the tab kept rendering the conversation that
       * had just been put away, so the app disagreed with itself about a chat the user had explicitly
       * cleared. Navigating away was not enough — the tab is still there to click.
       *
       * ⚠️ By SESSION, not by index. Every caller knows which chat it just retired or cleared and none
       * of them knows where it sits in the strip; making them find it would put the same search in
       * three places and make the fourth caller the one that forgets.
       */
      closeSessionTab: (server: ServerConnection.Key, sessionId: string) => {
        const index = store.findIndex(
          (tab) => tab.type === "session" && tab.server === server && tab.sessionId === sessionId,
        )
        if (index >= 0) removeTab(index)
      },
      /**
       * The chat behind an OPEN ROUTE turned out not to exist — drop its tab and STAY, so the route
       * can render its own "this chat is gone" card. See `removeTab`'s `stay` parameter: this is a
       * reconciliation, not a dismissal, and it must not navigate on the user's behalf.
       */
      removeSessionTab(input: Omit<SessionTab, "type">) {
        const index = store.findIndex(
          (tab) => tab.type === "session" && tab.server === input.server && tab.sessionId === input.sessionId,
        )
        if (index !== -1) removeTab(index, true)
      },
      removeServer(key: ServerConnection.Key) {
        const drafts = store.flatMap((tab) => (tab.type === "draft" && tab.server === key ? [tab.draftID] : []))
        const removed = store.filter((tab) => tab.server === key).map(tabKey)
        setStore((tabs) => tabs.filter((tab) => tab.server !== key))
        for (const key of removed) memory.remove(key)
        if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        for (const draftID of drafts) removeDraftPersisted(draftID)
        if (server.key === key) navigate("/")
      },
      /**
       * A COLLEAGUE'S TAB FOLLOWS ITS COLLEAGUE.
       *
       * 🔴 The ECS lens, applied where it was being broken: a colleague is the ENTITY and its chat is
       * a COMPONENT reached THROUGH it — *"a component does not get an identity of its own"*. A tab
       * that pins a `sessionId` forever is that component holding its own identity, and it goes wrong
       * the moment the kernel legitimately replaces the chat.
       *
       * Reassignment does exactly that: `agent/reassignment.ts` archives the chat and opens a
       * successor in the new folder, on purpose, because a cross-project move is refused outright.
       * The kernel is coherent — *"an archived predecessor keeps the name but yields the seat"* — but
       * the tab kept pointing at the predecessor.
       *
       * Measured on the owner's instance 2026-09-03: the folder was set at 00:34:46, which archived
       * `ses_daedalus` and created a correctly-rooted successor. The tab stayed on the archived chat,
       * which then took **296 events over three more minutes** — a `hello.c` written and compiled into
       * the colleague's scratch, and a write to the real project refused as `external_directory_write`,
       * correctly, because that session's root really was scratch. The successor sat at 2 events,
       * unopened. The agent then advised widening permissions, which was the only remedy visible from
       * inside a conversation nobody had told it was superseded.
       *
       * ⚠️ Keyed on the AGENT, never on the archived id: the successor's id is generated (the
       * canonical `ses_<agent>` seat is held by the predecessor, deliberately, so a returning name
       * cannot open into someone else's transcript). The colleague is the only stable identity here,
       * which is the point.
       */
      followAgentChats: (rows: ReadonlyArray<{ id: string; agent?: string; parentID?: string; archived: boolean }>) => {
        const live = new Map<string, string>()
        for (const row of rows)
          if (!row.archived && row.parentID === undefined && row.agent) live.set(row.agent, row.id)
        const archived = new Set(rows.filter((row) => row.archived).map((row) => row.id))
        const moves: Array<{ from: string; to: string }> = []
        for (const tab of store) {
          if (tab.type !== "session" || tab.server !== server.key) continue
          if (!tab.agent || !archived.has(tab.sessionId)) continue
          const successor = live.get(tab.agent)
          // No successor means the colleague genuinely has no live chat — retired, say. Leave the tab
          // alone so the route can say so; inventing a destination would be the dead end.
          if (successor && successor !== tab.sessionId) moves.push({ from: tab.sessionId, to: successor })
        }
        if (moves.length === 0) return
        const active = params.id
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              for (const move of moves) {
                const tab = tabs.find((item) => item.type === "session" && item.sessionId === move.from)
                if (tab?.type === "session") tab.sessionId = move.to
              }
            }),
          )
          // Travel only if the user is LOOKING at the chat that moved. Re-pointing a background tab
          // must not yank them out of what they are reading.
          const followed = moves.find((move) => move.from === active)
          if (followed) {
            const tab = store.find((item) => item.type === "session" && item.sessionId === followed.to)
            if (tab) navigateTab(tab)
          }
        })
      },
      removeSessions: (input: SessionTabsRemovedDetail) => {
        const targetServer = input.server ?? server.key
        const removed = store
          .filter(
            (tab) => tab.type === "session" && tab.server === targetServer && input.sessionIDs.includes(tab.sessionId),
          )
          .map(tabKey)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const sessionIDs = new Set(input.sessionIDs)
              const currentHref =
                targetServer === server.key && params.dir && params.id
                  ? tabHref({
                      type: "session",
                      server: targetServer,
                      sessionId: params.id,
                    })
                  : undefined
              const currentIndex = currentHref
                ? tabs.findIndex(
                    (tab) => tab.type === "session" && tab.server === targetServer && tabHref(tab) === currentHref,
                  )
                : -1
              const currentTab = tabs[currentIndex]
              const removedCurrent =
                currentTab?.type === "session" &&
                currentTab.server === targetServer &&
                sessionIDs.has(currentTab.sessionId)

              for (let i = tabs.length - 1; i >= 0; i--) {
                const tab = tabs[i]
                if (!tab || tab.type !== "session") continue
                if (tab.server !== targetServer) continue
                if (!sessionIDs.has(tab.sessionId)) continue
                tabs.splice(i, 1)
              }

              if (!removedCurrent) return
              const nextTab =
                tabs.slice(currentIndex).find((tab) => tab.type === "session") ??
                tabs.slice(0, currentIndex).findLast((tab) => tab.type === "session")
              if (nextTab) navigateTab(nextTab)
              else navigate("/")
            }),
          )
          if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        })
        for (const key of removed) memory.remove(key)
      },
      select: navigateTab,
      remember(tab: Tab) {
        const key = tabKey(tab)
        if (recentKey() !== key) setRecentKey(key)
      },
      toggleHome(input: { home: boolean; current?: Tab }) {
        if (input.home) {
          const tab = store.find((tab) => tabKey(tab) === recentKey())
          if (tab) navigateTab(tab)
          return
        }
        if (input.current) {
          setRecentKey(tabKey(input.current))
          navigate("/")
          return
        }
        navigate("/")
      },
      /**
       * Tasks ordered by when they were last opened, most recent first, with any never-visited task
       * appended in store order. Never drops a task: the strip slices this, and a task missing from
       * BOTH lists would be unreachable rather than merely further along.
       */
      recentOrder(): Tab[] {
        const rank = new Map((recent.keys ?? []).map((key, index) => [key, index] as const))
        return [...store].sort((a, b) => {
          const left = rank.get(tabKey(a)) ?? Number.MAX_SAFE_INTEGER
          const right = rank.get(tabKey(b)) ?? Number.MAX_SAFE_INTEGER
          return left === right ? store.indexOf(a) - store.indexOf(b) : left - right
        })
      },
      state<T>(tab: Tab, name: string, init: () => T) {
        return memory.ensure(tabKey(tab), name, init)
      },
    }

    return { ...actions, store, ready, recentReady }
  },
})
