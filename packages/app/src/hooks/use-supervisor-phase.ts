import { createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { usePlatform, type SupervisorPhase } from "@/context/platform"

/**
 * The local instance supervisor's phase, as ONE source for every surface that reports an outage.
 *
 * 🔴 **Why this is shared rather than inlined twice.** Two screens must tell the user the retry
 * ladder has stopped: `ConnectionBanner` (a strip over a live app) and `ConnectionError` (the
 * full-screen state a reload during an outage lands on). They never render together — the app gate
 * picks one — but if each subscribed on its own they could disagree about whether the instance is
 * coming back, and "what is in force right now" would have two authorities. Principle 12(d) is about
 * saying what is in force; it is worth nothing if two surfaces say different things.
 *
 * Measured 2026-08-18 in the packaged app: reloading mid-outage with the supervisor already in
 * `gave-up` showed *"Could not reach Local Server / Retrying automatically..."* — the exact
 * promise-nobody-is-keeping the terminal panel was built to kill, because the panel was mounted
 * behind the health gate that had just failed. The phase replay landed on an unmounted component.
 *
 * ⚠️ An absent supervisor (web, or a shell driving a remote instance) stays `undefined` — the honest
 * answer is "no supervisor", never a fabricated phase, so a caller must treat `undefined` as "I do
 * not know" and keep its calm copy.
 */
export function useSupervisorPhase(): { phase: Accessor<SupervisorPhase | undefined>; gaveUp: Accessor<boolean> } {
  const platform = usePlatform()
  const [phase, setPhase] = createSignal<SupervisorPhase | undefined>()

  onMount(() => {
    const api = platform.supervisor
    if (!api) return
    // Subscribe FIRST, then read: the reverse order can drop a transition that lands between the two,
    // and the one it would drop is the terminal one that never repeats.
    const unsubscribe = api.subscribe((state) => setPhase(state))
    void api.getState().then(
      (state) => setPhase((current) => current ?? state),
      () => undefined, // a supervisor that cannot answer is reported by its absence, never a fake phase
    )
    onCleanup(unsubscribe)
  })

  /** The only phase that ends the retry story. Everything else is "still working on it". */
  const gaveUp = createMemo(() => phase()?.phase === "gave-up")
  return { phase, gaveUp }
}
