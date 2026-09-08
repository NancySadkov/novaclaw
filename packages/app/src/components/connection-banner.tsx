import { Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSupervisorPhase } from "@/hooks/use-supervisor-phase"
import { useServer } from "@/context/server"
import type { ServerStreamStatus } from "@/context/server-sdk"

// Dependability P2 (uix-dependability-plan): the calm "connection lost — reconnecting…" banner.
// A small fixed strip — never a dialog, never a stack trace, never traps focus (pointer-events
// none; there is nothing to click). It reads the ACTIVE server's SSE stream status and:
//   · shows after the trouble persists >2s (retry blips must not flicker it),
//   · escalates its subline by WALL-CLOCK once the outage runs long (the stream loop's failure
//     cadence is topology-dependent — heartbeat-paced, not retry-paced — so time is the only
//     honest measure of "still down"),
//   · flips to a brief "Reconnected" confirmation and dismisses itself when the stream returns.
//
// 🔴 THE TERMINAL STATE, added after measuring the supervisor (2026-08-18). The local supervisor's
// restart ladder is BOUNDED — five fast crashes and it stops, permanently, by design. Until now the
// only trace of that was a `[supervise] crash loop …` line in server.log, and this banner went on
// showing *"Still trying. Your work is safe; this clears by itself once the instance is back"* —
// a sentence that is false the moment nobody is trying any more. A bound whose terminal state is
// invisible is indistinguishable from an infinite retry, so the phase is now read from the platform
// supervisor and `gave-up` turns the strip into an INTERACTIVE panel that names the outage and
// offers the repair (a full restart). Everything else stays a passive strip.
//
// ⚠️ The supervisor is optional on purpose: on the web, and when the desktop shell drives a REMOTE
// instance, no local process is being restarted and this file must not invent a phase. Absent
// supervisor ⇒ exactly the old time-based behaviour.
const SHOW_AFTER_MS = 2_000
const STILL_TRYING_AFTER_MS = 15_000
const RESTORED_FLASH_MS = 1_500
const TROUBLE = new Set<ServerStreamStatus>(["connecting", "reconnecting"])

/** What the strip is saying. `stopped` is the only one that is interactive. */
export type BannerMode = "hidden" | "reconnecting" | "still-trying" | "restored" | "stopped"

/**
 * The whole render decision, pure — so the interesting combinations are assertable without a DOM.
 *
 * ⚠️ **`supervisorGaveUp` alone is NOT enough to accuse the connection, and this is the trap worth
 * naming.** The supervisor watches the LOCAL sidecar, while the banner reports whichever instance
 * the shell is currently driving. On a desktop shell pointed at a remote instance both are true at
 * once — the local sidecar can be permanently down while the server the user is actually talking to
 * is perfectly healthy — and a terminal "this instance stopped" panel over a working session would
 * be a false alarm with a Restart button attached to it. So the terminal state is only reported when
 * the ACTIVE stream is also not connected: two independent facts, required together.
 */
export function bannerMode(input: {
  readonly stream: ServerStreamStatus
  /** The 2s anti-flicker gate has elapsed on a troubled stream. */
  readonly visible: boolean
  readonly longOutage: boolean
  readonly restored: boolean
  readonly supervisorGaveUp: boolean
}): BannerMode {
  if (input.supervisorGaveUp && input.stream !== "connected") return "stopped"
  if (input.visible) return input.longOutage ? "still-trying" : "reconnecting"
  if (input.restored) return "restored"
  return "hidden"
}

export function ConnectionBanner() {
  const global = useGlobal()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()

  const status = createMemo<ServerStreamStatus>(() => {
    const conn = server.current
    // No instance at all is ConnectionGate's screen, not the banner's.
    if (!conn) return "idle"
    return global.ensureServerCtx(conn).sdk.streamStatus()
  })

  const [visible, setVisible] = createSignal(false)
  const [longOutage, setLongOutage] = createSignal(false)
  const [restored, setRestored] = createSignal(false)
  // ONE source for the supervisor phase, shared with ConnectionError — see the hook for why.
  const { gaveUp } = useSupervisorPhase()
  const [repairing, setRepairing] = createSignal(false)
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let escalateTimer: ReturnType<typeof setTimeout> | undefined
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  const clearTroubleTimers = () => {
    if (showTimer) clearTimeout(showTimer)
    if (escalateTimer) clearTimeout(escalateTimer)
    showTimer = undefined
    escalateTimer = undefined
  }

  const mode = createMemo(() =>
    bannerMode({
      stream: status(),
      visible: visible(),
      longOutage: longOutage(),
      restored: restored(),
      supervisorGaveUp: gaveUp(),
    }),
  )

  createEffect(
    on(status, (s) => {
      if (TROUBLE.has(s)) {
        if (!visible() && !showTimer)
          showTimer = setTimeout(() => {
            showTimer = undefined
            setVisible(true)
          }, SHOW_AFTER_MS)
        if (!escalateTimer && !longOutage())
          escalateTimer = setTimeout(() => {
            escalateTimer = undefined
            setLongOutage(true)
          }, STILL_TRYING_AFTER_MS)
        return
      }
      clearTroubleTimers()
      if (s === "connected" && visible()) {
        // Only confirm a recovery the user actually saw us struggling through.
        setRestored(true)
        if (flashTimer) clearTimeout(flashTimer)
        flashTimer = setTimeout(() => setRestored(false), RESTORED_FLASH_MS)
      }
      setVisible(false)
      setLongOutage(false)
    }),
  )

  // A give-up is worth showing IMMEDIATELY. It is a settled fact rather than a symptom that might
  // clear, so it does not wait out the 2s anti-flicker delay the stream status does.
  createEffect(
    on(gaveUp, (over) => {
      if (!over) return
      clearTroubleTimers()
      setVisible(true)
      setLongOutage(false)
    }),
  )

  onCleanup(() => {
    clearTroubleTimers()
    if (flashTimer) clearTimeout(flashTimer)
  })

  const repair = () => {
    if (repairing()) return
    setRepairing(true)
    void platform.restart().catch(() => setRepairing(false))
  }

  return (
    <Show when={mode() !== "hidden"}>
      <div
        class="fixed top-3 left-1/2 -translate-x-1/2 z-100 select-none"
        // 🔴 `pointer-events-auto` is EXPLICIT and not redundant, because `pointer-events` INHERITS.
        // Measured in the packaged app 2026-08-18: on a first run the Welcome tour dialog sets inline
        // `pointer-events: none` on `<body>`, so this container computed `none` with a clean class
        // list — removing `pointer-events-none` yields "inherit from parent", never "auto". The
        // Restart button was dead in exactly the situation a new user meets it, and because an
        // element with `pointer-events: none` is transparent to hit-testing,
        // `document.elementFromPoint` at the button's centre returned the element BEHIND it.
        classList={{
          "pointer-events-none": mode() !== "stopped",
          "pointer-events-auto": mode() === "stopped",
        }}
      >
        <div class="flex flex-col items-center gap-0.5 px-4 py-2 rounded-lg bg-surface-base shadow-lg border border-border-weak-base text-center">
          <Show when={mode() === "stopped"}>
            <span class="text-12-regular text-text-strong">{language.t("app.connection.stopped.title")}</span>
            <span class="text-12-regular text-text-weak max-w-80">
              {language.t("app.connection.stopped.description")}
            </span>
            <button
              type="button"
              class="mt-1.5 px-3 py-1 rounded-md text-12-regular bg-surface-strong text-text-strong border border-border-weak-base hover:bg-surface-hover disabled:opacity-60"
              disabled={repairing()}
              onClick={repair}
            >
              {language.t(repairing() ? "app.connection.stopped.restarting" : "app.connection.stopped.restart")}
            </button>
          </Show>
          <Show when={mode() === "reconnecting" || mode() === "still-trying"}>
            <span class="text-12-regular text-text-strong">{language.t("app.connection.reconnecting")}</span>
            <Show when={mode() === "still-trying"}>
              <span class="text-12-regular text-text-weak">{language.t("app.connection.stillTrying")}</span>
            </Show>
          </Show>
          <Show when={mode() === "restored"}>
            <span class="text-12-regular text-text-base">{language.t("app.connection.restored")}</span>
          </Show>
        </div>
      </div>
    </Show>
  )
}
