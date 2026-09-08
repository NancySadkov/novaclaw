import { createEffect, createMemo, createResource, createSignal, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { KeybindV2 } from "@novaclaw/ui/v2/keybind-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"

import { LayoutRoute, useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { TitlebarTabStrip } from "@/components/titlebar-tab-strip"
import { revealTabInStrip } from "@/components/titlebar-tab-gesture"
import { NovaClawWordmark } from "@/components/brand"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import {
  readSessionAgentChatsDetail,
  readSessionTabsRemovedDetail,
  SESSION_AGENT_CHATS_EVENT,
  SESSION_TABS_REMOVED_EVENT,
} from "@/components/titlebar-session-events"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { tabKey, useTabs } from "@/context/tabs"

const v2TitlebarHeight = 36
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.

export function Titlebar() {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const server = useServer()
  const navigate = useNavigate()
  const location = useLocation()
  const mobile = createMediaQuery("(max-width: 767px)")
  const bottom = createMemo(() => mobile() && settings.general.mobileTitlebarPosition() === "bottom")

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  // The desktop shell is Electron (electron-vite + electron-builder), so "desktop on Windows" IS
  // "Electron on Windows". A second memo used to draw that distinction back when a Tauri build was
  // also conceivable; it is gone, and nothing forks on the shell any more.
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const minHeight = () => {
    const height = v2TitlebarHeight
    if (mac()) return `${height / zoom()}px`
    if (windows()) return `${height / Math.min(titlebarZoom(), 1)}px`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  // ⚠️ A `const nav = createMemo(() => settings.general.showNavigation())` sat here and `nav()` was
  // never called. It gated back/forward BUTTONS that the v2 titlebar does not have — the two
  // commands below are all that survives of them, and they are reachable from the palette and on
  // mod+[ / mod+]. Deleted with the setting (2026-08-07).
  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  // ⚠️ `data-tauri-drag-region` below KEEPS its name despite the `tauri` prefix — it is NOT Tauri
  // residue. It is the selector `@novaclaw/ui/src/styles/base.css` (~line 85) uses to set
  // `app-region: drag`, plus `app-region: no-drag` on interactive descendants — which is the whole
  // mechanism that makes the frameless Electron titlebar draggable and double-click-maximizable.
  // Chromium handles both natively off that CSS, so there is deliberately NO JS drag/maximize
  // handler here; the ones that used to sit at this spot called a Tauri window object that no
  // build we ship has ever injected, and were therefore unreachable no-ops. Renaming the attribute
  // means editing that stylesheet in the same commit.

  return (
    <header
      data-slot="titlebar-v2"
      classList={{
        "shrink-0 relative flex flex-row": true,
        "h-9 bg-v2-background-bg-deep overflow-visible": true,
        "order-last": bottom(),
      }}
      style={{
        "min-height": minHeight(),
        "padding-left": mac() && !mobile() ? `${84 / zoom()}px` : 0,
        width: windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "max-width": windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "align-self": windows() ? "flex-start" : undefined,
      }}
      data-tauri-drag-region
    >
      {/* The legacy (pre-v2) titlebar branch is gone with the legacy shell; this body is
          unconditional now. It stays an IIFE so its local hooks/resources keep their own
          scope instead of colliding with the outer component's bindings. */}
      {(() => {
        const layout = useLayout()
        const global = useGlobal()

        const tabs = useTabs()
        const tabsStore = tabs.store
        const tabsStoreActions = tabs
        const [session] = createResource(
          () => {
            const route = layout.route()
            if (route.type !== "session") return undefined
            const conn = global.servers
              .list()
              .find((item) => ServerConnection.key(item) === (route.server ?? server.key))
            return conn ? { route, sdk: global.ensureServerCtx(conn).sdk } : undefined
          },
          ({ route, sdk }) =>
            sdk.client.v2.session
              .get({ sessionID: route.sessionId })
              .then((x) => x.data?.data)
              .catch(() => {}),
        )

        const matchRoute = (route: LayoutRoute) => {
          if (route.type === "home") return
          if (route.type === "draft") {
            return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
          }
          if (route.type === "session") {
            const main = tabsStore.find(
              (item) => item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
            )
            if (main) return main
            const s = session()
            if (s?.parentID && collapsesIntoParent(s)) {
              const parentID = s.parentID
              const parent = tabsStore.find(
                (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
              )
              if (parent) return parent
            }
          }
        }

        /**
         * 🔴 **Which sessions share their parent's tab — keyed on TYPE, not on parentage.**
         *
         * It read `parentID ?? id`, which says "a child never gets its own tab". What it MEANS is
         * "a spawned WORKER never gets its own tab" — a fleet of sub-agents must not each open one.
         * The two agreed until a fork became a branch of its source (2026-08-28): a conversation a
         * person opened deliberately would have shared the tab of the chat it came from, leaving one
         * of the two transcripts unreachable while the other was on screen.
         *
         * The schema already draws this line — `type: "interactive" | "sub-agent" | …` — and the
         * spawner stamps `sub-agent` at both call sites, so the right field was there all along.
         *
         * ⚠️ Anything else gets its own tab, including a session whose `type` is absent. Rows written
         * before the column existed are not workers, and a stale row must not silently swallow a
         * chat's tab.
         */
        const collapsesIntoParent = (s: { type?: string | undefined }) => s.type === "sub-agent"

        const currentTab = () => matchRoute(layout.route())

        createEffect(() => {
          const route = layout.route()
          if (!tabs.ready()) return
          const tab = currentTab()
          if (tab) {
            // Landing on any tab means the removal guard is spent.
            tabsStoreActions.clearRemoved()
            tabs.remember(tab)
            return
          }
          // Home, an app page, anything that is not a session: the user has left, so the suppression
          // has done its job and must not outlive it.
          if (route.type !== "session") tabsStoreActions.clearRemoved()

          if (route.type === "session") {
            const s = session()
            if (!s) return
            const sessionId = collapsesIntoParent(s) ? (s.parentID ?? s.id) : s.id
            /**
             * ⚠️ The colleague only when this session IS the tab. A child session maps onto its
             * PARENT's tab, and the child's own agent is not necessarily the parent's — stamping it
             * here would file the parent's tab under the wrong colleague and collapse it into a tab
             * that has nothing to do with it. The strip fills the parent in from its own session.
             */
            const agent = s.parentID ? undefined : s.agent
            const next = { server: route.server ?? server.key, sessionId, agent }
            /**
             * 🔴 **Follow what the store hands back** (owner, 2026-08-28). This effect is the choke
             * point every door funnels through — Contacts, the launcher, a deep link, a restored
             * window all arrive as a navigation — so enforcing one-tab-per-colleague here covers
             * them all. But by the time it runs the route has ALREADY moved: if the invariant hands
             * back the colleague's existing tab, we have to travel to it, or the strip highlights
             * one chat while the page renders another.
             */
            // Removing a tab re-runs this effect before its lifecycle navigation settles. Do not put
            // that same tab back during the transition.
            if (tabsStoreActions.removedKey() === tabKey({ type: "session", ...next })) return
            const tab = tabsStoreActions.addSessionTab(next)
            if (tab.type === "session" && tab.sessionId !== sessionId) tabsStoreActions.select(tab)
          }
        })

        makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
          const detail = readSessionTabsRemovedDetail(event)
          if (!detail) return
          tabsStoreActions.removeSessions(detail)
        })

        // A colleague's tab follows its colleague — see `notifySessionAgentChats` for why this is on
        // the event stream and not on the dialog that changes a folder.
        makeEventListener(window, SESSION_AGENT_CHATS_EVENT, (event) => {
          const detail = readSessionAgentChatsDetail(event)
          if (!detail) return
          tabsStoreActions.followAgentChats(detail.rows)
        })

        // ⚠️ "Am I on the launcher" is the PATHNAME, not `layout.route().type` (owner, 2026-08-13:
        // Home switched to the last task instead of leaving the app). `currentRoute` only classifies
        // session-shaped URLs, so every app page — /notes, /files, /recipes, … — falls through to
        // `{type: "home"}`. The toggle then believed it was already home and ran the other half of
        // its contract: jump to the most recent task. From inside an app the Home button therefore
        // did the one thing it must never do — go somewhere that is not home.
        const toggleHome = () => tabs.toggleHome({ home: location.pathname === "/", current: currentTab() })

        command.register("titlebar-home", () => [
          {
            id: "home.toggle",
            title: language.t("home.title"),
            category: language.t("command.category.view"),
            keybind: "mod+b",
            hidden: true,
            onSelect: toggleHome,
          },
        ])

        command.register("tabs", () => {
          const current = currentTab()

          return [
            {
              id: `tab.prev`,
              category: "tab",
              title: "",
              keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
              hidden: true,
              onSelect: () => {
                let index = tabsStore.findIndex((tab) => tab === currentTab())
                if (index === -1) return

                index -= 1
                if (index === -1) index = tabsStore.length - 1

                const next = tabsStore[index]
                if (next) tabs.select(next)
              },
            },
            {
              id: `tab.next`,
              category: "tab",
              title: "",
              keybind: `mod+option+ArrowRight,ctrl+tab`,
              hidden: true,
              onSelect: () => {
                let index = tabsStore.findIndex((tab) => tab === currentTab())
                if (index === -1) return

                index += 1
                if (index === tabsStore.length) index = 0

                const next = tabsStore[index]
                if (next) tabs.select(next)
              },
            },
          ].filter((v) => v !== undefined)
        })

        const [tabsAreOverflowing, setTabsAreOverflowing] = createSignal(false)

        return (
          <div
            class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 px-2 md:pr-3"
            classList={{
              "pt-2": !bottom(),
              "pb-2": bottom(),
              "md:pl-2": mac(),
              "md:pl-4": !mac(),
            }}
          >
            <BrandBadge onToggle={toggleHome} />
            {/* Home lives on the brand badge now (Start-button style) — no separate Home button. */}
            <TitlebarTabStrip
              tabs={tabsStore}
              currentTab={currentTab}
              activeServerKey={server.key}
              forceTruncate={tabsAreOverflowing()}
              onOverflowChange={setTabsAreOverflowing}
              onNavigate={(tab, el) => {
                tabs.select(tab)
                revealTabInStrip(el)
              }}
              onReorder={(keys) => tabsStoreActions.reorder(keys)}
            />

            {/* Contacts owns the complete roster; the titlebar never grows a second task manager. */}
            <TooltipV2 placement="bottom" value={language.t("nav.tasks.all")} class="shrink-0">
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="large"
                class="!w-9 shrink-0"
                data-component="titlebar-task-list"
                icon={<IconV2 name="bullet-list" />}
                onClick={() => navigate("/tasks")}
                aria-label={language.t("nav.tasks.all")}
              />
            </TooltipV2>
            <TitlebarV2Right />
          </div>
        )
      })()}
    </header>
  )
}

function TitlebarV2Right() {
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <div id="novaclaw-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
    </div>
  )
}

// The top-left brand badge doubles as the Home button — click the NovaClaw logo + version to return
// to the home launcher from anywhere (Windows Start / macOS Apple-menu metaphor). This replaces the
// separate Home nav button; the first-run tour calls it out (help.tour.step.home).
function BrandBadge(props: { onToggle: () => void }) {
  const location = useLocation()
  const language = useLanguage()
  const command = useCommand()
  const isHome = () => location.pathname === "/"
  return (
    <TooltipV2
      placement="bottom"
      value={
        <>
          {language.t("home.title")}
          <KeybindV2 keys={command.keybindParts("home.toggle")} variant="neutral" />
        </>
      }
      class="shrink-0"
    >
      <button
        type="button"
        data-component="brand-home-button"
        // ⚠️ The TOGGLE, not `navigate("/")`. The keybind (mod+b) has always run `toggleHome`, so
        // clicking and pressing did different things: the key returned you to the task you came
        // from, the click only ever went home (owner, 2026-08-12). A control and its shortcut
        // disagreeing is worse than either behaviour alone — you cannot learn what the button does.
        onClick={() => props.onToggle()}
        aria-label={language.t("home.title")}
        aria-pressed={isHome()}
        class="flex shrink-0 items-center rounded-md py-0.5 pl-1 pr-1.5 transition-colors hover:bg-v2-background-bg-layer-02 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-border-border-focus)]"
        classList={{ "bg-v2-background-bg-layer-01": isHome() }}
      >
        <NovaClawWordmark showVersion class="text-[13px] leading-none" />
      </button>
    </TooltipV2>
  )
}
