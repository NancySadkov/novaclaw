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
  /** The updater layer's live status, or `undefined` while it cannot be proved. */
  readonly probe: (() => Promise<boolean | undefined>) | undefined
}

export type UpdaterNetworkPolicy =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "airgap" | "policy-unavailable" }

/**
 * Resolve the updater's network authority at the moment it is about to check.
 *
 * This decision belongs at the updater controller, not at a timer or button. Every caller then
 * crosses the same fail-closed boundary, including callers that do not exist yet. A missing,
 * malformed, failed, or throwing sidecar probe is UNKNOWN and therefore refused; it is never
 * translated into "online" merely because the status service is unavailable.
 */
export async function updaterNetworkPolicy(input: AirgapInput): Promise<UpdaterNetworkPolicy> {
  if (input.env === "true" || input.env === "1") return { allowed: false, reason: "airgap" }
  if (!input.probe) return { allowed: false, reason: "policy-unavailable" }
  try {
    const airgapped = await input.probe()
    if (airgapped === true) return { allowed: false, reason: "airgap" }
    if (airgapped === false) return { allowed: true }
    return { allowed: false, reason: "policy-unavailable" }
  } catch {
    return { allowed: false, reason: "policy-unavailable" }
  }
}

/**
 * Read the updater's own layer from `/shell/offline` instead of inferring it from the aggregate
 * `enabled` bit. The controller and the status surface therefore use the same named gate. An older
 * or malformed instance that cannot make that claim is unknown and fails closed.
 */
export function updaterAirgapFromManifest(input: unknown): boolean | undefined {
  const status = input as { enabled?: unknown; layers?: unknown } | undefined
  const layers = status?.layers
  if (!Array.isArray(layers)) return undefined
  const updater = layers.find(
    (layer): layer is { layer: number; name: string; active: boolean } =>
      typeof layer === "object" &&
      layer !== null &&
      (layer as { layer?: unknown }).layer === 6 &&
      (layer as { name?: unknown }).name === "auto-update" &&
      typeof (layer as { active?: unknown }).active === "boolean",
  )
  if (updater?.active === true) return true
  // Permit egress only when BOTH the named updater layer and aggregate policy say they are off.
  // A disagreement is a broken status surface, not evidence that the machine is online.
  if (updater?.active === false && status?.enabled === false) return false
  return undefined
}
