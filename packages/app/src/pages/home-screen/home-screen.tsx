import { Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useBuiltinApps } from "@/apps/builtins"
import { registeredApps, type HomeApp } from "@/apps/registry"
import { AppTile } from "./app-tile"
import { HelpTour, HELP_SEEN_KEY } from "./help-tour"

const PER_PAGE = 24

// A friendly time-of-day greeting — the home is a product, not a terminal.
function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return "Good night"
  if (h < 12) return "Good morning"
  if (h < 18) return "Good afternoon"
  return "Good evening"
}

// The NovaClaw home screen — an iOS-style launcher: app tiles laid across swipeable pages. Pages use
// native CSS scroll-snap (touch-friendly, no gesture library); page dots + arrow keys navigate on
// desktop. Apps are the built-ins merged with the extensible registry (plugin / agent apps), so the
// grid grows as the OS does. Visual hierarchy: one gold HERO tile (Chats) anchors the eye on the cool
// purple field; a greeting header + capability hint frame the grid without competing with it.
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
      <div class="flex flex-col items-center gap-1 pt-10 pb-2 px-6 text-center select-none">
        <h1 class="text-[26px] font-semibold tracking-tight text-v2-text-text-base [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]">{greeting()}</h1>
        <p class="text-[13px] font-medium text-v2-text-text-muted">
          Open <span class="text-v2-text-text-accent">Chats</span> and ask — agents can also build new apps for this screen.
        </p>
      </div>
      <div
        ref={scroller}
        onScroll={onScroll}
        class="flex-1 min-h-0 w-full flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <For each={pages()}>
          {(pageApps) => (
            <div class="snap-center shrink-0 w-full h-full flex items-start justify-center overflow-y-auto pt-6">
              {/* Explicit minmax(0,5rem) tracks (not auto) so a col-span-2 hero stretches to 2 tracks
                  + gap, while tracks can still COMPRESS below 5rem on phone widths — fixed tracks
                  would overflow a 360px viewport and clip the left column unreachably (centered flex
                  overflow has no start-edge scroll). Tiles are w-full inside their track. */}
              <div class="grid w-full [grid-template-columns:repeat(4,minmax(0,5rem))] sm:[grid-template-columns:repeat(5,minmax(0,5rem))] md:[grid-template-columns:repeat(6,minmax(0,5rem))] gap-x-4 sm:gap-x-7 gap-y-9 px-4 py-8 pt-2 sm:px-8 max-w-[62rem] justify-center">
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
