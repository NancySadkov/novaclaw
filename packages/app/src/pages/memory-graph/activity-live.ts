import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useServerSDK, type ServerStreamStatus } from "@/context/server-sdk"
import {
  clearOverlay,
  decodeMemoryEvent,
  emptyActivity,
  foldActivity,
  isBurst,
  markSynced,
  mayReconcile,
  initialLink,
  pruneActivity,
  REFRESH_DEBOUNCE_MS,
  stepLink,
  type ActivityState,
  type LinkState,
} from "./activity"
import { reducedMotionQuery, watchMedia } from "./reduced-motion"

/**
 * THE LIVE OVERLAY'S WIRING — the impure half of `activity.ts`.
 *
 * 🔴 **One subscription, the app's existing one.** The Memory app rides `useServerSDK().event`,
 * which is the single `GET /global/event` stream the whole shell already shares. A second SSE
 * connection would double an instance's subscriber count for one open tab, and polling would break
 * the rule this whole slice exists to obey: the UI is a thin client that may be on another machine,
 * so it is told what happened rather than asking repeatedly whether anything did.
 *
 * ⚠️ **Subscribed with `listen`, not `on(directory)`.** Memory is a server-GLOBAL singleton — one
 * graph per instance, like the SQLite database — so its events are not a property of any workspace
 * directory. Keying the subscription on one would silently miss every write made from a session
 * running somewhere else, which is the exact failure ("shows what the surfaces it knows about are
 * doing") that publishing from the STORE was designed to prevent.
 */
export interface MemoryActivityFeed {
  readonly state: Accessor<ActivityState>
  /** Live, and honouring `prefers-reduced-motion` as a LISTENER, not a value read once at mount. */
  readonly reducedMotion: Accessor<boolean>
  readonly streamStatus: Accessor<ServerStreamStatus>
  /** True between losing the stream and finishing the re-read that repairs the gap. */
  readonly reconciling: Accessor<boolean>
  /** The page calls this when its own re-read has settled. */
  readonly synced: () => void
}

/**
 * @param onReconcile re-read the store after a gap in the stream — BEFORE anything animates.
 * @param onRefresh   re-read after a write, debounced. A flare is instant; the node it points at
 *                    only exists on the canvas after a fetch, so one without the other is a
 *                    highlight on empty space.
 */
export function createMemoryActivity(options: {
  readonly onReconcile: () => void
  readonly onRefresh: () => void
  /**
   * Is a mark on the canvas right now? A flare's clock starts when the answer becomes yes.
   *
   * ⚠️ Without it a new memory's flare burns out on empty space: the caption lands within ~100 ms
   * of the event, and the NODE only exists after the debounced re-read. Absent = "assume visible",
   * which is right for a surface that has no canvas.
   */
  readonly isVisible?: (id: string) => boolean
}): MemoryActivityFeed {
  const sdk = useServerSDK()
  const [state, setState] = createSignal<ActivityState>(emptyActivity())
  const [reconciling, setReconciling] = createSignal(false)

  // --- reduced motion, as a LIVE query -----------------------------------------------------------
  //
  // ⚠️ WATCHED, never sampled — `reduced-motion.ts` carries the reasoning and the tests. The rule
  // lives there rather than inline because "a later change is delivered" is the whole claim, and it
  // is not checkable against an inline listener inside a Solid root.
  const [reducedMotion, setReducedMotion] = createSignal(false)
  onCleanup(watchMedia(reducedMotionQuery(), setReducedMotion))

  // --- the gap: watermark, reconcile, resume -----------------------------------------------------
  let link: LinkState = initialLink()
  let lastReconcileAt: number | undefined
  /**
   * 🔴 **RECONCILE BEFORE ANIMATING.** While this is true the fold keeps captions and state and
   * drops flares, because an event that arrives during a gap describes a store the canvas has not
   * re-read yet — a flare on a node that is not there is a promise the picture cannot keep.
   */
  const staleUntilReread = () => reconciling()

  createEffect(
    on(
      () => sdk().streamStatus(),
      (status) => {
      const step = stepLink(link, status)
      link = step.link
      // Anything that is not `connected` is a gap — including the very first moments, when we have
      // no link yet and the resources are still loading. Suppressing animation there costs nothing
      // and spares the user a flare for a write that happened before they opened the page.
      if (status !== "connected") {
        setReconciling(true)
        return
      }
      // A first connection is not a RE-connection: the page's own resources already fetched on
      // mount, so there is nothing to repair and an extra round trip here would be polling by
      // another name.
      if (!step.reconcile) {
        setReconciling(false)
        return
      }
      const now = Date.now()
      // A flapping connection produces a `connected` every few hundred ms; one re-read per edge
      // turns a bad network into a load test on the instance that is already hard to reach. And a
      // tab returning from being throttled crosses this edge ONCE, which is the whole requirement.
      if (!mayReconcile(lastReconcileAt, now)) {
        setReconciling(false)
        return
      }
      lastReconcileAt = now
      // Drop the overlay first: whatever was highlighted described the store before the gap.
      setState((current) => clearOverlay(current))
      options.onReconcile()
      },
    ),
  )

  // --- the subscription --------------------------------------------------------------------------
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      options.onRefresh()
    }, REFRESH_DEBOUNCE_MS)
  }
  onCleanup(() => {
    if (refreshTimer) clearTimeout(refreshTimer)
  })

  createEffect(() => {
    const server = sdk()
    // Idempotent — the shell starts this stream on mount. Called anyway so the Memory app does not
    // depend on the order two providers happen to run in.
    void server.event.start()
    const unsubscribe = server.event.listen((bus) => {
      const activity = decodeMemoryEvent(bus.details as { type?: unknown; properties?: unknown })
      if (!activity) return
      const now = Date.now()
      setState((current) => {
        // ⚠️ TWO reasons not to animate, and they are not the same news. A gap or a replay is
        // something the user COULD NOT have seen, and the rail says so; reduced motion is them
        // getting what they asked for, and saying so after every event would be the noise the
        // setting exists to remove.
        const missed = staleUntilReread() || isBurst(current, now)
        return foldActivity(current, activity, { now, animate: !reducedMotion() && !missed, missed })
      })
      if (activity.kind !== "recalled") scheduleRefresh()
    })
    onCleanup(unsubscribe)
  })

  // --- expiry ------------------------------------------------------------------------------------
  //
  // The timer only runs while there IS something to expire. A permanent 5 Hz tick on an idle
  // instance is a busy loop wearing a feature's clothes.
  createEffect(() => {
    const current = state()
    if (current.flares.size === 0 && current.recall === undefined) return
    const timer = setInterval(
      () =>
        setState((value) =>
          pruneActivity(value, Date.now(), options.isVisible ? { isVisible: options.isVisible } : undefined),
        ),
      200,
    )
    onCleanup(() => clearInterval(timer))
  })

  return {
    state,
    reducedMotion,
    streamStatus: () => sdk().streamStatus(),
    reconciling,
    synced: () => {
      setReconciling(false)
      setState((current) => markSynced(current))
    },
  }
}
