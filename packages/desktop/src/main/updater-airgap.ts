/**
 * May the updater talk to the network right now?
 *
 * 🔴 **NC-SEC-001 — the startup poll raced the policy it was supposed to obey.** The airgap force-off
 * reads `NOVACLAW_OFFLINE` first and otherwise asks the sidecar, which is the authoritative source:
 * offline mode is a STORE setting and is true independently of the env var. But the probe is not
 * assigned until the sidecar has spawned, and the startup poll fires before that — so the first
 * check of every launch evaluated `sidecarOfflineProbe ? … : false` with the probe still undefined,
 * concluded "not airgapped", and went to the network. `updater.start()` does not stop at asking: when
 * a release exists it downloads.
 *
 * So an instance airgapped through the store — the only way a user can set it, since the env var is
 * ours — contacted the update host once per launch, before anything could say no.
 *
 * ⚠️ **Unknown policy is treated as AIRGAPPED.** This is the codebase's own idiom, not a preference:
 * the test runner "fails closed because running a memory-heavy test without the crash-predicting
 * measurement would only guess that the machine is safe". Guessing wrong here leaks; guessing wrong
 * the other way delays an update check to the next ten-minute tick, by which time the sidecar is up
 * and the answer is real.
 */
export type AirgapInput = {
  /** `NOVACLAW_OFFLINE`, ours to set — checked first because it needs no sidecar. */
  readonly env: string | undefined
  /** The sidecar's offline status, or `undefined` while it is still starting. */
  readonly probe: (() => Promise<boolean>) | undefined
}

export async function updaterIsAirgapped(input: AirgapInput): Promise<boolean> {
  if (input.env === "true" || input.env === "1") return true
  // ⚠️ `?? true`, not `?? false`. This single character is the finding.
  if (!input.probe) return true
  return input.probe()
}
