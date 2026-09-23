import { Component, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
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
import { deletePersistedApp } from "@/apps/persisted"
import { useConfirm } from "@/components/dialog-confirm"
import { useExpertise } from "@/context/expertise"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection, useServer } from "@/context/server"
import { showToast } from "@/utils/toast"
import { createSettledResource } from "@/utils/settled-resource"
import { registeredApps, type HomeApp } from "@/apps/registry"
import { listDeployedRecipes, launchRecipe, undeployRecipe, type RecipeDeployment } from "@/utils/recipe-api"
import { sessionHref } from "@/utils/session-route"
import { usePlatform } from "@/context/platform"
import { AppTile } from "./app-tile"
import { HelpTour, HELP_SEEN_KEY } from "./help-tour"
import { createHomeTileClickGuard } from "./home-tile-click-guard"
import { NewAgentBar } from "./new-agent-bar"

const PER_PAGE = 24

// B5: persisted tile order. Saved ids come first (in saved order, unknown ids
// dropped); apps the layout has never seen append in their natural order — so a
// newly registered agent app still shows up without wiping the arrangement.
const ORDER_KEY = "novaclaw.home.order"

// Tiles that changed id, old → new. `applyOrder` drops ids it does not recognise and appends ids it
// has never seen, so without this a rename would silently move the renamed tile to the END of an
// existing user's launcher — the hero landing last is not a thing anyone would ask for.
// ⚠️ BOTH old ids map to the CURRENT one, not to each other: this is a lookup, not a chain, so
// `chats` must point at where the tile lives today rather than at the name it had in between.
const RENAMED_IDS: Readonly<Record<string, string>> = { chats: "contacts", tasks: "contacts" }

function loadOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === "string").map((id) => RENAMED_IDS[id] ?? id)
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
const SortableTile: Component<{
  app: HomeApp
  shouldSuppressOpen: () => boolean
  onDelete?: (app: HomeApp) => void
  onContextAction?: (app: HomeApp, event: MouseEvent) => void
}> = (props) => {
  // eslint-disable-next-line solid/reactivity -- sortable identity is stable per mount
  const sortable = createSortable(props.app.id)
  return (
    // touch-auto (not touch-none): a touch starting on a tile must still pan the snap pages / vertical
    // list — the iOS-launcher metaphor. Mouse drag-reorder is unaffected (touch-action ignores mouse);
    // touch reorder yields to scrolling, which is the right trade for a launcher (uix.md §3.1 L1).
    <div
      use:sortable
      data-home-app-id={props.app.id}
      class="home-app-slot touch-auto"
      data-hero={props.app.hero ? "true" : undefined}
      classList={{
        "opacity-30": sortable.isActiveDraggable,
      }}
    >
      <AppTile app={props.app} shouldSuppressOpen={props.shouldSuppressOpen} onDelete={props.onDelete} onContextAction={props.onContextAction} />
    </div>
  )
}

/**
 * Which tiles a person may throw away.
 *
 * `agent` apps are persisted manifests (`DELETE /app/:id` removes them for good). `plugin` apps are
 * registered in-process by code that is loaded on every start, so "deleting" one would reappear on
 * reload — offering it would be a lie. Built-ins are the product.
 */
const isRemovable = (app: HomeApp) => app.source === "agent"

// The NovaClaw home screen — an iOS-style launcher: app tiles laid across swipeable pages. Pages use
// native CSS scroll-snap (touch-friendly, no gesture library); page dots + arrow keys navigate on
// desktop. Apps are the built-ins merged with the extensible registry (plugin / agent apps), so the
// grid grows as the OS does. One gold Nova tile anchors the cool purple field; app instruments
// use existing local glyphs in a compact shared frame.
export const HomeScreen: Component = () => {
  const builtins = useBuiltinApps()
  const manifestApps = useManifestApps()
  const navigate = useNavigate()
  const platform = usePlatform()
  const server = useServer()
  const global = useGlobal()
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const [deployed, { refetch: refreshDeployed }] = createSettledResource(
    () => connection()?.http,
    (http) => listDeployedRecipes(http),
  )
  const [contextTarget, setContextTarget] = createSignal<{ recipe: RecipeDeployment; x: number; y: number }>()
  const [htmlLaunch, setHtmlLaunch] = createSignal<{ title: string; url: string }>()
  const openDeployment = async (recipe: RecipeDeployment) => {
    const conn = connection()
    if (!conn) return
    try {
      const launch = await launchRecipe(conn.http, recipe.slug)
      if (launch.kind === "chat" && launch.sessionID) navigate(sessionHref(ServerConnection.key(conn), launch.sessionID))
      else if (launch.kind === "html" && launch.url) {
        const url = new URL(launch.url, conn.http.url).href
        if (platform.openRecipeBrowser) await platform.openRecipeBrowser(url, recipe.name)
        else setHtmlLaunch({ title: recipe.name, url })
      }
      else if (launch.kind === "console" && launch.ptyID)
        navigate(`/terminal?launch=${encodeURIComponent(launch.ptyID)}`)
      void refreshDeployed()
    } catch (error) {
      showToast({ variant: "error", title: `Could not launch ${recipe.name}`, description: String(error) })
    }
  }
  const deployedApps = createMemo<HomeApp[]>(() =>
    (deployed() ?? []).map((recipe) => ({
      id: `deployed:${recipe.slug}`,
      title: recipe.name,
      icon: "sparkles",
      tile: "/assets/skin/tiles/recipes.png",
      accent: "#b396dc",
      source: "builtin",
      subtitle: recipe.state === "deploying" ? "Deploying · open agent chat" : recipe.description || "Launch recipe",
      open: () => void openDeployment(recipe),
    })),
  )
  const { atLeast } = useExpertise()
  const [order, setOrder] = createSignal<string[]>(loadOrder())
  const apps = createMemo<HomeApp[]>(() =>
    // Expertise gate (uix.md §6.4): a tile whose minLevel exceeds the current level is hidden (e.g.
    // Terminal in Normal/Advanced). Filter before ordering so a hidden tile can't hold a saved slot.
    applyOrder(
      [...builtins(), ...manifestApps(), ...registeredApps(), ...deployedApps()].filter((app) => atLeast(app.minLevel ?? "normal")),
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
  const confirm = useConfirm()
  const language = useLanguage()

  const undeploy = async (recipe: RecipeDeployment) => {
    setContextTarget(undefined)
    const conn = connection()
    if (!conn) return
    const proceed = await confirm({
      title: `Undeploy ${recipe.name}?`,
      description: "This removes the deployed copy and its Home icon. Your editable recipe stays in Recipes Studio.",
      confirmLabel: "Undeploy",
      destructive: true,
    })
    if (!proceed) return
    try {
      await undeployRecipe(conn.http, recipe.slug)
      await refreshDeployed()
      showToast({ variant: "success", title: `${recipe.name} undeployed` })
    } catch (error) {
      showToast({ variant: "error", title: `Could not undeploy ${recipe.name}`, description: String(error) })
    }
  }

  onMount(() => {
    const refresh = () => void refreshDeployed()
    window.addEventListener("focus", refresh)
    window.addEventListener("novaclaw:recipe-deployed", refresh)
    onCleanup(() => {
      window.removeEventListener("focus", refresh)
      window.removeEventListener("novaclaw:recipe-deployed", refresh)
    })
  })

  /**
   * Throw an agent-contributed app away — the launcher's one destructive action, so it confirms
   * first and names what it is deleting. Reached two ways, because a launcher has two vocabularies
   * for this and a person will reach for whichever they know: right-click the tile, or drag it onto
   * Trash (`onDragEnd` below).
   */
  const deleteApp = async (app: HomeApp) => {
    if (!isRemovable(app)) return
    const proceed = await confirm({
      title: language.t("home.launcher.delete.title", { app: app.title }),
      description: language.t("home.launcher.delete.description"),
      confirmLabel: language.t("home.launcher.delete.confirm"),
    })
    if (!proceed) return
    const conn = server.current ?? global.servers.list()[0]
    if (!conn) return
    const removed = await deletePersistedApp(conn.http, app.id, ServerConnection.key(conn))
    if (!removed) {
      showToast({ variant: "error", title: language.t("home.launcher.delete.failed", { app: app.title }) })
      return
    }
    // Drop it from the saved arrangement too, or a re-registered app with the same id would
    // silently inherit the deleted tile's slot.
    setOrder((ids) => {
      const next = ids.filter((id) => id !== app.id)
      try {
        localStorage.setItem(ORDER_KEY, JSON.stringify(next))
      } catch {
        // localStorage unavailable — the order still applies for this session.
      }
      return next
    })
    showToast({ variant: "success", title: language.t("home.launcher.delete.done", { app: app.title }) })
  }

  // A drag past the sensor's activation threshold still emits a trailing `click` on the tile when the
  // pointer is released over it — which would OPEN the app the user was only reordering. We detect a
  // real drag by the pointer's TRAVEL and swallow that one trailing click. We deliberately do NOT arm on
  // solid-dnd's onDragStart: its pointer sensor also starts a drag after a stationary 250ms hold (zero
  // movement), and a slow/held tap must still open. The guard clears on the macrotask AFTER release —
  // the compatibility click fires synchronously first (so it's suppressed), while a later keyboard
  // (Enter/Space) activation, which has no preceding pointer move, is never swallowed.
  //
  // ⚠️ The listeners are on WINDOW in the capture phase (so the whole gesture is visible regardless of
  // the pointer capture the sensor sets), which means they see gestures that have nothing to do with
  // the launcher. Arming on all of them left the launcher INERT after any drag elsewhere in the shell
  // that never received a pointerup. So arming is scoped to a pointerdown on a tile inside the
  // scroller, movement is attributed by pointerID, and the flag is cleared on pointercancel and on
  // window blur — the two ways a gesture ends without a pointerup.
  const clickGuard = createHomeTileClickGuard()
  const shouldSuppressOpen = () => clickGuard.shouldSuppress()

  onMount(() => {
    if (typeof window === "undefined") return
    const onDown = (e: PointerEvent) => {
      const tile = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-home-app-id]") : undefined
      if (!tile || !scroller?.contains(tile) || !tile.dataset.homeAppId) {
        // ⚠️ Scoped to THIS pointer (review H6). Clearing unconditionally let a second touch
        // anywhere on the page abandon the first pointer's live gesture, so its release over a tile
        // emitted an unswallowed click and the app opened mid-reorder.
        clickGuard.clear(e.pointerId)
        return
      }
      clickGuard.begin({ pointerID: e.pointerId, x: e.clientX, y: e.clientY })
    }
    const onMove = (e: PointerEvent) => {
      clickGuard.move({ pointerID: e.pointerId, x: e.clientX, y: e.clientY })
    }
    const onUp = (e: PointerEvent) => {
      if (!clickGuard.end(e.pointerId)) return
      // Cleared next macrotask: the trailing click (if any) has already fired and been suppressed by now.
      setTimeout(() => clickGuard.clear(), 0)
    }
    const onCancel = (e: PointerEvent) => {
      if (clickGuard.end(e.pointerId)) clickGuard.clear()
    }
    const onBlur = () => clickGuard.clear()
    // Capture phase + window so we see the whole gesture regardless of pointer capture the sensor sets.
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("pointermove", onMove, true)
    window.addEventListener("pointerup", onUp, true)
    window.addEventListener("pointercancel", onCancel, true)
    window.addEventListener("blur", onBlur)
    onCleanup(() => {
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("pointercancel", onCancel, true)
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("pointermove", onMove, true)
      window.removeEventListener("pointerup", onUp, true)
    })
  })

  // B5 drag-to-reorder: recompute the full order from the current arrangement,
  // move dragged-before-target, persist. Reordering is always live (pointer
  // activation distance keeps taps opening apps) — no separate edit mode.
  const onDragEnd = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable || draggable.id === droppable.id) return
    // ⚠️ The drag-onto-Trash delete gesture is GONE (Trash retired as a tile, 2026-09-16). Right-click
    // on a removable tile is the one remaining vocabulary for deleting a contributed app. If a delete
    // drop target returns, it belongs here — and it must not also be a sortable tile, or a drop reads
    // as both "delete" and "reorder".
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
    <div data-component="home-launcher" tabindex={0} onKeyDown={onKey}>
      <Show when={deployed.failed}>
        <div role="status" class="flex items-center justify-center gap-3 px-3 py-2 text-xs text-v2-state-fg-warning">
          <span>Deployed recipes unavailable.</span>
          <button type="button" class="underline" onClick={() => void refreshDeployed()}>Try again</button>
        </div>
      </Show>
      {/* No logo, no greeting (owner 2026-07-26). They cost ~7rem above the fold to say nothing the user
          does not know — on a phone that pushed the tiles themselves off screen. The brand still lives in
          the titlebar; the home screen is for launching things. */}
      <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
        <DragDropSensors />
        <div ref={scroller} onScroll={onScroll} class="home-pages no-scrollbar">
          <SortableProvider ids={apps().map((app) => app.id)}>
            {/* ⚠️ `<Index>` on the PAGES, `<For>` on the tiles (review H2). `pages()` is a fresh
                array of fresh arrays on every recomputation, so `<For>`'s reference keying disposed
                and rebuilt every page — and with it every tile inside — on each drag-release. A page
                has no identity beyond its position, which is exactly what `<Index>` keys on; the
                TILES do have identity, and `builtins.tsx` now keeps theirs stable so `<For>` can
                move them instead of remounting them. */}
            <Index each={pages()}>
              {(pageApps) => (
                <div class="home-page">
                  {/* Shrinkable tracks keep the two-column hero and every app inside narrow phones.
                      The page scrolls vertically when a short window cannot fit the whole grid. */}
                  <div class="home-grid">
                    <For each={pageApps()}>
                      {(app) => (
                        <SortableTile
                          app={app}
                          shouldSuppressOpen={shouldSuppressOpen}
                          {...(isRemovable(app) ? { onDelete: (target: HomeApp) => void deleteApp(target) } : {})}
                          {...(app.id.startsWith("deployed:")
                            ? {
                                onContextAction: (_target: HomeApp, event: MouseEvent) => {
                                  const recipe = (deployed() ?? []).find((item) => `deployed:${item.slug}` === app.id)
                                  if (recipe) setContextTarget({ recipe, x: event.clientX, y: event.clientY })
                                },
                              }
                            : {})}
                        />
                      )}
                    </For>
                  </div>
                </div>
              )}
            </Index>
          </SortableProvider>
        </div>
      </DragDropProvider>
      <Show when={contextTarget()}>
        {(target) => (
          <>
            <div class="fixed inset-0 z-50" onClick={() => setContextTarget(undefined)} onContextMenu={(event) => { event.preventDefault(); setContextTarget(undefined) }} />
            <div
              role="menu"
              class="fixed z-50 rounded-xl border border-v2-border-border-strong bg-v2-background-bg-layer-03 p-1 shadow-2xl"
              style={{ left: `${Math.min(target().x, window.innerWidth - 190)}px`, top: `${Math.min(target().y, window.innerHeight - 55)}px` }}
            >
              <button role="menuitem" type="button" class="rounded-lg px-4 py-2 text-sm text-v2-text-text-base hover:bg-v2-background-bg-layer-04" onClick={() => void undeploy(target().recipe)}>
                Undeploy {target().recipe.name}
              </button>
            </div>
          </>
        )}
      </Show>
      <Show when={htmlLaunch()}>
        {(launch) => (
          <div class="fixed inset-0 z-50 flex flex-col bg-v2-background-bg-deep" role="dialog" aria-label={launch().title}>
            <div class="flex items-center justify-between border-b border-v2-border-border-base px-4 py-3">
              <strong class="text-v2-text-text-base">{launch().title}</strong>
              <button type="button" class="text-v2-text-text-muted hover:text-v2-text-text-base" onClick={() => setHtmlLaunch(undefined)}>Close</button>
            </div>
            <iframe title={launch().title} src={launch().url} sandbox="allow-scripts" class="min-h-0 flex-1 border-0 bg-white" />
          </div>
        )}
      </Show>
      <Show when={pages().length > 1}>
        <div class="home-page-dots">
          <For each={pages()}>
            {(_, i) => (
              <button
                type="button"
                aria-label={`Page ${i() + 1}`}
                aria-current={i() === page() ? "page" : undefined}
                onClick={() => goto(i())}
              />
            )}
          </For>
        </div>
      </Show>
      {/* The primary action, pinned to the BOTTOM — the same screen position as a chat's composer,
          so the click-to-create transition into the new chat doesn't jump (owner call 2026-07-14). */}
      <div class="home-command">
        <NewAgentBar />
      </div>
    </div>
  )
}
