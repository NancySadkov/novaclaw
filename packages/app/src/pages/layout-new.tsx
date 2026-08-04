import { createEffect, createSignal, onMount, Show, Suspense, type ParentProps } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { makeEventListener } from "@solid-primitives/event-listener"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useJumpToAttentionCommand } from "@/apps/jump-to-attention"
import { useSettingsCommand } from "@/components/settings-dialog"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./layout/deep-links"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const location = useLocation()
  const navigate = useNavigate()
  const server = useServer()
  const tabs = useTabs()
  setNavigate(navigate)

  // `novaclaw://open-project` / `novaclaw://new-session` (desktop main → renderer → this window
  // event). The listener used to live in the legacy shell, which the default layout stopped
  // mounting — so deep links had been silently dead while the OS protocol handler stayed
  // registered. Both kinds land the same way the in-app project picker does: remember the
  // project, then open a draft in it.
  //
  // Queued rather than handled inline: the boot deep link arrives from an IPC promise that can
  // resolve before the persisted tab store has hydrated, and pushing a draft into a store that is
  // about to be overwritten by its own load loses it.
  const [pendingDeepLinks, setPendingDeepLinks] = createSignal<string[]>([])

  const openDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return
    const open = (directory: string, prompt?: string) => {
      layout.projects.open(directory)
      server.projects.touch(directory)
      tabs.newDraft({ server: server.key, directory }, prompt)
    }
    for (const directory of collectOpenProjectDeepLinks(urls)) open(directory)
    for (const link of collectNewSessionDeepLinks(urls)) open(link.directory, link.prompt)
  }

  createEffect(() => {
    const urls = pendingDeepLinks()
    if (urls.length === 0 || !tabs.ready()) return
    setPendingDeepLinks([])
    openDeepLinks(urls)
  })

  onMount(() => {
    const queue = (urls: string[]) => {
      if (urls.length === 0) return
      setPendingDeepLinks((previous) => [...previous, ...urls])
    }
    queue(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, ((event: Event) => {
      queue((event as CustomEvent<{ urls: string[] }>).detail?.urls ?? [])
    }) as EventListener)
  })
  // Always-live from anywhere in the shell: mod+j → the chat that needs you (uix-improvement slice 3).
  useJumpToAttentionCommand()
  // Settings + log export register HERE so every route (incl. the launcher) resolves them — the
  // macOS menu bar and the palette depend on that. This must stay the only "settings"-key owner:
  // a second register() with the same key evicts this one and takes the key down when it unmounts.
  useSettingsCommand()
  command.register("shell", () =>
    platform.platform === "desktop" && platform.exportDebugLogs
      ? [
          {
            id: "logs.export",
            title: "Export logs",
            category: language.t("command.category.settings"),
            onSelect: () => {
              void platform.exportDebugLogs?.()
            },
          },
        ]
      : [],
  )

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar update={update} />
      <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
        {/* A route that suspends renders NOTHING without a fallback — an empty shell with no way
            back, which is the dead end AGENTS.md's "never breaks in your hands" clause forbids. The
            fallback names the wait and offers the one control that always works.

            ⚠️ Keyed on PATHNAME ONLY, deliberately. Solid will not re-show a resolved Suspense's
            fallback, so the subtree has to be recreated per route for this to engage at all — but
            keying on `search` too (as the upstream PR did) remounts the page on any query-string
            change. `new-session.tsx` clears its deep-link `?prompt=` via setSearchParams while the
            user is typing, and `use-session-hash-scroll` replace-navigates with the search string;
            both would destroy the live page. Ported from
            https://github.com/NancySadkov/novaclaw/pull/11 by @DassaultFalconKing. */}
        <Show when={location.pathname} keyed>
          <Suspense
            fallback={
              <div
                role="status"
                class="flex min-h-0 flex-1 self-stretch flex-col items-center justify-center gap-3 text-sm text-v2-text-text-faint"
              >
                <span>
                  {language.t("common.loading")}
                  {language.t("common.loading.ellipsis")}
                </span>
                <button
                  type="button"
                  class="rounded-md px-3 py-1.5 font-medium text-v2-text-text-muted transition-colors hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
                  onClick={() => navigate("/")}
                >
                  {language.t("home.title")}
                </button>
              </div>
            }
          >
            {props.children}
          </Suspense>
        </Show>
      </main>
      {import.meta.env.DEV && <DebugBar inline />}
      {/* No floating HelpButton in the new layout — the Help app tile owns the tour (SP8; the old
          placeholder popover was dev-only lorem-ipsum competing with it). */}
      <ToastRegion v2 />
    </div>
  )
}
