import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
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
const SHOW_AFTER_MS = 2_000
const STILL_TRYING_AFTER_MS = 15_000
const RESTORED_FLASH_MS = 1_500
const TROUBLE = new Set<ServerStreamStatus>(["connecting", "reconnecting"])

export function ConnectionBanner() {
  const global = useGlobal()
  const server = useServer()
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
  let showTimer: ReturnType<typeof setTimeout> | undefined
  let escalateTimer: ReturnType<typeof setTimeout> | undefined
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  const clearTroubleTimers = () => {
    if (showTimer) clearTimeout(showTimer)
    if (escalateTimer) clearTimeout(escalateTimer)
    showTimer = undefined
    escalateTimer = undefined
  }

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
  onCleanup(() => {
    clearTroubleTimers()
    if (flashTimer) clearTimeout(flashTimer)
  })

  return (
    <Show when={visible() || restored()}>
      <div class="fixed top-3 left-1/2 -translate-x-1/2 z-100 pointer-events-none select-none">
        <div class="flex flex-col items-center gap-0.5 px-4 py-2 rounded-lg bg-surface-base shadow-lg border border-border-weak-base text-center">
          <Show
            when={visible()}
            fallback={<span class="text-12-regular text-text-base">{language.t("app.connection.restored")}</span>}
          >
            <span class="text-12-regular text-text-strong">{language.t("app.connection.reconnecting")}</span>
            <Show when={longOutage()}>
              <span class="text-12-regular text-text-weak">{language.t("app.connection.stillTrying")}</span>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  )
}
