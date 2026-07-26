import { Component, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useBuiltinApps } from "@/apps/builtins"
import { useManifestApps } from "@/apps/manifest-apps"
import { useExpertise } from "@/context/expertise"
import { registeredApps, type HomeApp } from "@/apps/registry"
import { AppTile } from "./app-tile"
import { HelpTour, HELP_SEEN_KEY } from "./help-tour"
import { NewAgentBar } from "./new-agent-bar"

const PER_PAGE = 24

// B5: persisted tile order. Saved ids come first (in saved order, unknown ids
// dropped); apps the layout has never seen append in their natural order — so a
// newly registered agent app still shows up without wiping the arrangement.
const ORDER_KEY = "novaclaw.home.order"

function loadOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

function applyOrder(apps: HomeApp[], order: string[]): HomeApp[] {
  const byId = new Map(apps.map((app) => [app.id, app]))
  const out: HomeApp[] = []
  for (const id of order) {
    const app = byId.get(id)
    if (app) {
      out.push(app)
      byId.delete(id)
    }
  }
  for (const app of apps) if (byId.has(app.id)) out.push(app)
  return out
}

// The sortable wrapper OWNS the grid placement (span classes must live on the
// grid item, which is now this div, not the tile's inner button). Drag uses the
// pointer sensor's activation distance, so plain clicks still open the app. The
// `shouldSuppressOpen` guard swallows the trailing click a drag-release emits.
const SortableTile: Component<{ app: HomeApp; shouldSuppressOpen: () => boolean }> = (props) => {
  // eslint-disable-next-line solid/reactivity -- sortable identity is stable per mount
  const sortable = createSortable(props.app.id)
  return (
    // touch-auto (not touch-none): a touch starting on a tile must still pan the snap pages / vertical
    // list — the iOS-launcher metaphor. Mouse drag-reorder is unaffected (touch-action ignores mouse);
    // touch reorder yields to scrolling, which is the right trade for a launcher (uix.md §3.1 L1).
    <div
      use:sortable
      class="touch-auto"
      classList={{
        "col-span-2 md:col-span-3 row-span-2": !!props.app.hero,
        "opacity-30": sortable.isActiveDraggable,
      }}
    >
      <AppTile app={props.app} shouldSuppressOpen={props.shouldSuppressOpen} />
    </div>
  )
}

// The NovaClaw home screen — an iOS-style launcher: app tiles laid across swipeable pages. Pages use
// native CSS scroll-snap (touch-friendly, no gesture library); page dots + arrow keys navigate on
// desktop. Apps are the built-ins merged with the extensible registry (plugin / agent apps), so the
// grid grows as the OS does. Visual hierarchy: one gold HERO tile (Chats) anchors the eye on the cool
// purple field; a greeting header + capability hint frame the grid without competing with it.
export const HomeScreen: Component = () => {
  const builtins = useBuiltinApps()
  const manifestApps = useManifestApps()
  const { atLeast } = useExpertise()
  const [order, setOrder] = createSignal<string[]>(loadOrder())
  const apps = createMemo<HomeApp[]>(() =>
    // Expertise gate (uix.md §6.4): a tile whose minLevel exceeds the current level is hidden (e.g.
    // Terminal in Normal/Advanced). Filter before ordering so a hidden tile can't hold a saved slot.
    applyOrder(
      [...builtins(), ...manifestApps(), ...registeredApps()].filter((app) => atLeast(app.minLevel ?? "normal")),
      order(),
    ),
  )
  const pages = createMemo<HomeApp[][]>(() => {
    const all = apps()
    const out: HomeApp[][] = []
    for (let i = 0; i < all.length; i += PER_PAGE) out.push(all.slice(i, i + PER_PAGE))
    return out.length ? out : [all]
  })
  const [page, setPage] = createSignal(0)
  let scroller: HTMLDivElement | undefined
  const dialog = useDialog()

  // A drag past the sensor's activation threshold still emits a trailing `click` on the tile when the
  // pointer is released over it — which would OPEN the app the user was only reordering. We detect a
  // real drag by the pointer's TRAVEL and swallow that one trailing click. We deliberately do NOT arm on
  // solid-dnd's onDragStart: its pointer sensor also starts a drag after a stationary 250ms hold (zero
  // movement), and a slow/held tap must still open. `draggedClick` is cleared on the macrotask AFTER
  // release — the compatibility click fires synchronously first (so it's suppressed), while a later
  // keyboard (Enter/Space) activation, which has no preceding pointer move, is never swallowed.
  const DRAG_TRAVEL_PX = 10 // matches solid-dnd's pointer activation distance
  let pointerOrigin: { x: number; y: number } | null = null
  let draggedClick = false
  const shouldSuppressOpen = () => draggedClick

  onMount(() => {
    if (typeof window === "undefined") return
    const onDown = (e: PointerEvent) => {
      pointerOrigin = { x: e.clientX, y: e.clientY }
      draggedClick = false
    }
    const onMove = (e: PointerEvent) => {
      if (pointerOrigin && Math.hypot(e.clientX - pointerOrigin.x, e.clientY - pointerOrigin.y) > DRAG_TRAVEL_PX)
        draggedClick = true
    }
    const onUp = () => {
      pointerOrigin = null
      // Cleared next macrotask: the trailing click (if any) has already fired and been suppressed by now.
      setTimeout(() => {
        draggedClick = false
      }, 0)
    }
    // Capture phase + window so we see the whole gesture regardless of pointer capture the sensor sets.
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("pointermove", onMove, true)
    window.addEventListener("pointerup", onUp, true)
    window.addEventListener("pointercancel", onUp, true)
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("pointermove", onMove, true)
      window.removeEventListener("pointerup", onUp, true)
      window.removeEventListener("pointercancel", onUp, true)
    })
  })

  // B5 drag-to-reorder: recompute the full order from the current arrangement,
  // move dragged-before-target, persist. Reordering is always live (pointer
  // activation distance keeps taps opening apps) — no separate edit mode.
  const onDragEnd = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable || draggable.id === droppable.id) return
    const ids = apps().map((app) => app.id)
    const from = ids.indexOf(String(draggable.id))
    const to = ids.indexOf(String(droppable.id))
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    setOrder(ids)
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(ids))
    } catch {
      // localStorage unavailable — the order still applies for this session.
    }
  }

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
      {/* No logo, no greeting (owner 2026-07-26). They cost ~7rem above the fold to say nothing the user
          does not know — on a phone that pushed the tiles themselves off screen. The brand still lives in
          the titlebar; the home screen is for launching things. */}
      <div class="pt-4" />
      <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
        <DragDropSensors />
        <div
          ref={scroller}
          onScroll={onScroll}
          class="flex-1 min-h-0 w-full flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <SortableProvider ids={apps().map((app) => app.id)}>
            <For each={pages()}>
              {(pageApps) => (
                <div class="snap-center shrink-0 w-full h-full flex items-start justify-center overflow-y-auto pt-6">
                  {/* Explicit minmax(0,5rem) tracks (not auto) so a col-span-2 hero stretches to 2 tracks
                      + gap, while tracks can still COMPRESS below 5rem on phone widths — fixed tracks
                      would overflow a 360px viewport and clip the left column unreachably (centered flex
                      overflow has no start-edge scroll). Tiles are w-full inside their track. */}
                  <div class="grid w-full [grid-template-columns:repeat(4,minmax(0,5rem))] sm:[grid-template-columns:repeat(5,minmax(0,5rem))] md:[grid-template-columns:repeat(6,minmax(0,5rem))] gap-x-4 sm:gap-x-7 gap-y-9 px-4 py-8 pt-2 sm:px-8 max-w-[62rem] justify-center">
                    <For each={pageApps}>{(app) => <SortableTile app={app} shouldSuppressOpen={shouldSuppressOpen} />}</For>
                  </div>
                </div>
              )}
            </For>
          </SortableProvider>
        </div>
      </DragDropProvider>
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
      {/* The primary action, pinned to the BOTTOM — the same screen position as a chat's composer,
          so the click-to-create transition into the new chat doesn't jump (owner call 2026-07-14). */}
      <div class="w-full max-w-[42rem] shrink-0 px-6 pb-4">
        <NewAgentBar />
      </div>
    </div>
  )
}
