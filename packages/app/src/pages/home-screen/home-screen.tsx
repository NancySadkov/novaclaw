import { Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useBuiltinApps } from "@/apps/builtins"
import { registeredApps, type HomeApp } from "@/apps/registry"
import { AppTile } from "./app-tile"
import { HelpTour, HELP_SEEN_KEY } from "./help-tour"

const PER_PAGE = 24

// The NovaClaw home screen — an iOS-style launcher: app tiles laid across swipeable pages. Pages use
// native CSS scroll-snap (touch-friendly, no gesture library); page dots + arrow keys navigate on
// desktop. Apps are the built-ins merged with the extensible registry (plugin / agent apps), so the
// grid grows as the OS does. Replaces the recent-sessions `NewHome` at `/` (sessions now live behind
// the Chats + Processes apps).
export const HomeScreen: Component = () => {
  const builtins = useBuiltinApps()
  const apps = createMemo<HomeApp[]>(() => [...builtins(), ...registeredApps()])
  const pages = createMemo<HomeApp[][]>(() => {
    const all = apps()
    const out: HomeApp[][] = []
    for (let i = 0; i < all.length; i += PER_PAGE) out.push(all.slice(i, i + PER_PAGE))
    return out.length ? out : [all]
  })
  const [page, setPage] = createSignal(0)
  let scroller: HTMLDivElement | undefined
  const dialog = useDialog()

  // First run: auto-open the Help tour once (guarded by a localStorage flag); reopenable via the Help app.
  onMount(() => {
    try {
      if (!localStorage.getItem(HELP_SEEN_KEY)) {
        localStorage.setItem(HELP_SEEN_KEY, "1")
        void dialog.show(() => <HelpTour />)
      }
    } catch {
      // localStorage unavailable (e.g. a non-browser test env) — just skip the tour.
    }
  })

  const onScroll = () => {
    if (scroller) setPage(Math.round(scroller.scrollLeft / Math.max(1, scroller.clientWidth)))
  }
  const goto = (i: number) => scroller?.scrollTo({ left: i * scroller.clientWidth, behavior: "smooth" })
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") goto(Math.min(page() + 1, pages().length - 1))
    if (e.key === "ArrowLeft") goto(Math.max(page() - 1, 0))
  }

  return (
    <div class="flex flex-col items-center w-full h-full min-h-0" tabindex={0} onKeyDown={onKey}>
      <div
        ref={scroller}
        onScroll={onScroll}
        class="flex-1 min-h-0 w-full flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <For each={pages()}>
          {(pageApps) => (
            <div class="snap-center shrink-0 w-full h-full flex items-center justify-center overflow-y-auto">
              <div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-x-8 gap-y-10 p-8 max-w-[60rem]">
                <For each={pageApps}>{(app) => <AppTile app={app} />}</For>
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={pages().length > 1}>
        <div class="flex items-center gap-2 py-4">
          <For each={pages()}>
            {(_, i) => (
              <button
                type="button"
                aria-label={`Page ${i() + 1}`}
                class="size-2 rounded-full transition-all"
                classList={{
                  "bg-v2-text-text-base scale-110": i() === page(),
                  "bg-v2-border-border-strong": i() !== page(),
                }}
                onClick={() => goto(i())}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
