import type { Config } from "@novaclaw/sdk/v2/client"

/**
 * The Health & recovery tab's readable state — separated from `recovery.tsx` for the reason
 * `confinement-state.ts` is separated from `confinement.tsx`: a claim a screen makes about the
 * kernel needs a mechanical check, and a predicate buried in a component has none.
 *
 * The whole of it is one question — is "pick work back up" on? — and that question has exactly one
 * way to go wrong, below.
 */

/**
 * 🔴 **ABSENT MEANS ON, and getting this backwards is the defect worth a test.**
 *
 * `ConfigHarnessDrives.resolve` in core answers `info?.resumeInterrupted ?? true`, so an instance
 * that has never set the key HAS the behaviour. If this surface read a missing key as `false` it
 * would show every existing install a switch in the OFF position while the feature was running —
 * and a user who then flipped it on and off again would have **turned it off believing they had left
 * it alone**. The switch would have lied in both directions in one gesture.
 *
 * ⚠️ So this is `!== false`, not `=== true`, and the two are only the same when the key is present.
 */
export const resumeInterruptedOn = (config: Config | undefined): boolean =>
  config?.harness_drives?.resumeInterrupted !== false

/**
 * The patch to send when the switch moves.
 *
 * ⚠️ **Merges rather than replaces.** `harness_drives` carries the other recovery switches (reground,
 * children, imageShortcut); writing `{ resumeInterrupted: value }` alone would silently clear
 * whichever of them an operator had set. The tab only owns one field of a block it does not own.
 */
export const resumeInterruptedPatch = (
  config: Config | undefined,
  value: boolean,
): { readonly harness_drives: NonNullable<Config["harness_drives"]> } => ({
  harness_drives: { ...(config?.harness_drives ?? {}), resumeInterrupted: value },
})
