import { createEffect, createMemo, createResource, createSignal, For, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { KeybindV2 } from "@novaclaw/ui/v2/keybind-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { MenuV2 } from "@novaclaw/ui/v2/menu-v2"

import { LayoutRoute, useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { TitlebarTabStrip } from "@/components/titlebar-tab-strip"
import { NovaClawWordmark } from "@/components/brand"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "@/components/titlebar-session-events"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { tabHref, tabKey, useTabs, type Tab } from "@/context/tabs"

const v2TitlebarHeight = 36
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.

export type TitlebarUpdate = {
  version: () => string | undefined
  installing: () => boolean
  install: () => void
}

export function Titlebar(props: { update?: TitlebarUpdate }) {
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
  const updateState = createMemo<TitlebarUpdatePillState>(() => {
    const installing = props.update?.installing() ?? false
    const version = props.update?.version()
    return {
      visible: version !== undefined || installing,
      installing,
      label: "Update",
      ariaLabel: language.t("toast.update.action.installRestart"),
      title: version ? `Update ${version}` : undefined,
      onInstall: () => props.update?.install(),
    }
  })
  const v2RightState = createMemo<TitlebarV2RightState>(() => ({
    update: updateState(),
  }))

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
            if (s?.parentID) {
              const parentID = s.parentID
              const parent = tabsStore.find(
                (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
              )
              if (parent) return parent
            }
          }
        }

        const currentTab = () => matchRoute(layout.route())

        createEffect(() => {
          const route = layout.route()
          if (!tabs.ready()) return
          const tab = currentTab()
          if (tab) {
            tabs.remember(tab)
            return
          }

          if (route.type === "session") {
            const s = session()
            if (!s) return
            const sessionId = s.parentID ?? s.id
            const next = { server: route.server ?? server.key, sessionId }
            tabsStoreActions.addSessionTab(next)
          }
        })

        makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
          const detail = readSessionTabsRemovedDetail(event)
          if (!detail) return
          tabsStoreActions.removeSessions(detail)
        })

        // The legacy new-tab "+" (draft tabs, mod+t) is RETIRED (owner 2026-07-22): chat
        // creation lives in the launcher bar and the Chats page's New Session button.
        /**
         * How many tasks the strip shows. The rest are one click away in the list — a bar that grows
         * without limit stops being scannable long before it stops fitting, and the tab you want is
         * almost always one you touched recently.
         */
        /**
         * A task's label for the list. Read from the sync cache the strip already fills — resolving
         * every task here would turn opening a menu into N requests, and a menu that fetches is a
         * menu that stalls. An unresolved task shows its folder, never a blank row.
         */
        const tabTitle = (tab: Tab) => {
          if (tab.type === "draft") return tab.directory.split(/[\/]/).filter(Boolean).at(-1) ?? language.t("command.session.new")
          const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
          const cached = conn ? global.ensureServerCtx(conn).sync.session.peek(tab.sessionId) : undefined
          return cached?.title?.trim() || language.t("nav.tasks.untitled")
        }

        const VISIBLE_TABS = 4
        const visibleTabs = createMemo(() => {
          const ordered = tabs.recentOrder()
          const shown = ordered.slice(0, VISIBLE_TABS)
          const current = currentTab()
          // ⚠️ The current task is ALWAYS shown, even if it is not in the recent few — otherwise
          // opening an old task from the list would leave you looking at a strip that does not
          // contain the thing on screen.
          if (current && !shown.some((tab) => tabKey(tab) === tabKey(current))) {
            return [current, ...shown.slice(0, VISIBLE_TABS - 1)]
          }
          return shown
        })
        const hiddenTabs = createMemo(() => {
          const visible = new Set(visibleTabs().map(tabKey))
          return tabs.recentOrder().filter((tab) => !visible.has(tabKey(tab)))
        })
        const closeCurrent = () => {
          const current = currentTab()
          if (!current) return
          const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(current))
          if (index !== -1) tabsStoreActions.removeTab(index)
        }

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
            current && {
              id: "tab.close",
              category: "tab",
              title: language.t("command.tab.close"),
              keybind: "mod+w",
              hidden: true,
              onSelect: () => {
                tabsStoreActions.removeTab(tabsStore.findIndex((tab) => current === tab))
              },
            },
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
            {/* Tasks is hidden on the launcher ("/") — you launch apps from the tiles there — and
                also INSIDE a task (owner, 2026-08-12): the tab strip beside it already lists your
                tasks, so the button only competes with them for the same click. It remains on the
                other app pages (Notes, Files, Settings…), where nothing else leads back. */}
            {/* Home lives on the brand badge now (Start-button style) — no separate Home button. */}
            <Show when={location.pathname !== "/" && layout.route().type !== "session"}>
              <TooltipV2 placement="bottom" value={language.t("home.app.tasks.name")} class="shrink-0">
                <IconButtonV2
                  type="button"
                  variant="ghost-muted"
                  size="large"
                  class="!w-9 shrink-0"
                  icon={<IconV2 name="tab" />}
                  onClick={() => navigate("/tasks")}
                  aria-label={language.t("home.app.tasks.name")}
                />
              </TooltipV2>
            </Show>

            <TitlebarTabStrip
              tabs={visibleTabs()}
              currentTab={currentTab}
              activeServerKey={server.key}
              forceTruncate={tabsAreOverflowing()}
              onOverflowChange={setTabsAreOverflowing}
              onNavigate={(tab, el) => {
                tabs.select(tab)
                el?.scrollIntoView({ behavior: "instant" })
              }}
              onClose={(tab) => {
                const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(tab))
                if (index !== -1) tabsStoreActions.removeTab(index)
              }}
              onReorder={(keys) => tabsStoreActions.reorder(keys)}
            />

            {/* All tasks, including the ones the strip is not showing. The count is on the button so
                "there are others" is legible without opening it. */}
            <Show when={tabsStore.length > 0}>
              <MenuV2 placement="bottom" gutter={4}>
                <MenuV2.Trigger
                  data-component="titlebar-task-list"
                  aria-label={language.t("nav.tasks.all")}
                  class="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 focus-visible:outline-none data-[expanded]:bg-v2-background-bg-layer-01"
                >
                  <IconV2 name="bullet-list" />
                  <Show when={hiddenTabs().length > 0}>
                    <span>{hiddenTabs().length}</span>
                  </Show>
                </MenuV2.Trigger>
                <MenuV2.Portal>
                  <MenuV2.Content class="max-h-[60vh] w-[280px] overflow-y-auto">
                    <MenuV2.Group>
                      <MenuV2.GroupLabel>{language.t("nav.tasks.all")}</MenuV2.GroupLabel>
                      <For each={tabs.recentOrder()}>
                        {(tab: Tab) => (
                          <MenuV2.Item onSelect={() => tabs.select(tab)}>
                            <span class="min-w-0 flex-1 truncate">{tabTitle(tab)}</span>
                            <Show when={currentTab() && tabKey(currentTab()!) === tabKey(tab)}>
                              <IconV2 name="check" class="shrink-0" />
                            </Show>
                          </MenuV2.Item>
                        )}
                      </For>
                    </MenuV2.Group>
                  </MenuV2.Content>
                </MenuV2.Portal>
              </MenuV2>
            </Show>

            {/* ONE close button, for the task you are looking at. A per-tab ✕ sits inside the thing
                you are aiming at, so "switch" and "destroy" are a few pixels apart — and on touch,
                less than a fingertip. This cannot be hit while reaching for another tab. */}
            <Show when={currentTab()}>
              <TooltipV2 placement="bottom" value={language.t("nav.tasks.close")} class="shrink-0">
                <IconButtonV2
                  type="button"
                  variant="ghost-muted"
                  size="large"
                  class="!w-9 shrink-0"
                  data-component="titlebar-task-close"
                  icon={<IconV2 name="xmark-small" />}
                  onClick={closeCurrent}
                  aria-label={language.t("nav.tasks.close")}
                />
              </TooltipV2>
            </Show>
            {/* The spacer that pushes the right-hand actions to the edge and lets the tab strip
                take the rest. It was briefly `#novaclaw-titlebar-center`, a portal host for a
                "Search {project} ⌘K" box (added 2026-08-07, removed by the owner on 2026-08-11):
                this row is the TAB STRIP, and a search field in it competes with the tabs for the
                one row a person reads constantly. `file.open` keeps its palette entry and keybind. */}
            <div class="flex min-w-0 flex-1" />
            <TitlebarV2Right state={v2RightState()} />
          </div>
        )
      })()}
    </header>
  )
}

type TitlebarUpdatePillState = {
  visible: boolean
  installing: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}

type TitlebarV2RightState = {
  update: TitlebarUpdatePillState
}

function TitlebarV2Right(props: { state: TitlebarV2RightState }) {
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <Show when={props.state.update.visible}>
        <TitlebarUpdateIconButton state={props.state.update} />
      </Show>
      <div id="novaclaw-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
    </div>
  )
}

function TitlebarUpdateIconButton(props: { state: TitlebarUpdatePillState }) {
  return (
    <div class="group relative mr-3 h-5 w-5 shrink-0 rounded-full bg-v2-background-bg-deep transition-[width] duration-150 ease-out hover:z-30 hover:w-[68px] focus-within:z-30 focus-within:w-[68px] motion-reduce:transition-none">
      <button
        type="button"
        class="absolute right-0 top-0 z-10 flex h-5 w-5 items-center justify-end overflow-hidden rounded-full bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent transition-[width,background-color] duration-150 ease-out group-hover:w-[68px] group-hover:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] group-focus-within:w-[68px] group-focus-within:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none"
        onClick={props.state.onInstall}
        disabled={props.state.installing}
        aria-busy={props.state.installing}
        aria-label={props.state.ariaLabel}
      >
        <span class="shrink-0 ml-[8px] mr-px text-[11px] text-v2-text-text-accent [font-weight:530] opacity-0 translate-x-2 motion-safe:transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-within:opacity-100 group-focus-within:translate-x-0 motion-reduce:translate-x-0">
          Update
        </span>
        <span class="flex size-5 shrink-0 items-center justify-center">
          <Show
            when={!props.state.installing}
            fallback={<span data-slot="titlebar-update-loader" aria-hidden="true" />}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
            </svg>
          </Show>
        </span>
      </button>
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
