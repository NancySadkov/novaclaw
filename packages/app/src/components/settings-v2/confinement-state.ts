import type { ShellStatus } from "@/utils/fs-api"
// ⚠️ TYPE-ONLY, as in the component file: `@novaclaw/core/agent-jail` imports `node:child_process` at
// module scope, so a VALUE import would follow the renderer into the browser bundle.
import type { BashPlan, ConfinementReason, Enclosure, JailPostureWire } from "@novaclaw/core/agent-jail"

/**
 * The confinement state machine, with NO component import.
 *
 * 🔴 **The placement is the fix.** `confinement.tsx` reaches `./parts/row` -> `TooltipV2` ->
 * `@kobalte/core`, which throws *"Client-only API called on the server side"* at MODULE SCOPE under the
 * unit tier: `test:unit` runs `bun test --preload ./happydom.ts` WITHOUT `--conditions=browser` (only
 * `test:browser` passes it), so solid-js resolves to its SERVER build. Any test whose import graph
 * reaches a Kobalte component dies before its first assertion.
 *
 * ⚠️ **It failed in the shape that hides itself.** bun reported `0 pass / 1 fail` — a LOAD error
 * dressed as a test failure — so this file's own ratchet was enforcing NOTHING while the suite merely
 * looked red. `confinement.test.ts` is the pin that keeps {@link BACKENDED_PLATFORMS} honest against the
 * kernel's `detectBackend`; it could not run at all.
 *
 * The split is the house pattern: `project-copy.ts`, `storage-entries.ts`, `computer-rules.ts`,
 * `tool-channel.ts`.
 */

/**
 * The instance-reported shell status, plus the confinement posture the instance MAY attach to it.
 *
 * ⚠️ `jail` is optional because the field rides an existing response (`GET /shell/status`) and an
 * instance older than this screen does not send it. That is a first-class state here, not an error —
 * see `"unreported"` below.
 */
export type ShellStatusWithJail = ShellStatus & {
  readonly jail?: ReportedPosture
  /** Optional for the same reason `jail` is: an older instance omits it and the row says so. */
  readonly enclosure?: Enclosure
}

/**
 * The posture as this screen may receive it.
 *
 * ⚠️ `bash` is optional HERE while it is required on the kernel's `JailPostureWire`, and the
 * widening is deliberate rather than sloppy: the one posture this screen may synthesise
 * (`UNPROBED_ON_THIS_PLATFORM`) has no per-turn outcomes, because those are the kernel's answers and
 * computing them in the renderer is exactly the restatement `bashPlan` exists to prevent. Modelling
 * that as "absent" costs one `Show`; modelling it with a cast would let a fabricated outcome table
 * reach a user. Everything else is the kernel's type, so a field added there arrives here typed.
 */
export type ReportedPosture = Omit<JailPostureWire, "bash"> & { readonly bash?: BashPlan }

/**
 * The platforms on which THIS build implements a sandbox backend.
 *
 * ⚠️ DERIVED, not decided here. `confinement.test.ts` drives the kernel's own `detectBackend` across
 * every platform string and fails if this list disagrees with it — so the day a Seatbelt or
 * AppContainer backend lands, the test goes red until this line and the copy catch up. Without that
 * pin this would be a normative claim about code in another package, which is the ruling-1 defect
 * class exactly.
 *
 * It is used for ONE inference, and only when the instance sent no posture: a host whose platform has
 * no backend at all cannot be confined, and saying so is not a guess. On a platform that DOES have a
 * backend, whether it works is unknowable from here (that is the whole AppArmor story), so we say we
 * do not know.
 */
export const BACKENDED_PLATFORMS: readonly string[] = ["linux"]

/**
 * What this screen can honestly say. Keyed by the kernel's own `ConfinementReason` wherever the
 * instance answered, plus the two states that are about the ANSWER rather than the host.
 */
export type ConfinementState =
  | { readonly kind: ConfinementReason; readonly jail: ReportedPosture; readonly platform: string }
  /** The instance is older than this screen: it has a backend-capable platform and did not say. */
  | { readonly kind: "unreported"; readonly platform: string }
  /** We could not reach the instance at all. Says "I do not know", never "you are unprotected". */
  | { readonly kind: "unknown" }

export function confinementState(status: ShellStatusWithJail | undefined): ConfinementState {
  if (!status) return { kind: "unknown" }
  const jail = status.jail
  if (jail) return { kind: jail.reason, jail, platform: status.platform }
  // No posture on the wire. Exactly one of the two remaining answers is honest.
  if (BACKENDED_PLATFORMS.includes(status.platform)) return { kind: "unreported", platform: status.platform }
  return { kind: "platform-unsupported", jail: UNPROBED_ON_THIS_PLATFORM, platform: status.platform }
}

export const UNPROBED_ON_THIS_PLATFORM: ReportedPosture = {
  kind: "none",
  fs: false,
  net: false,
  reason: "platform-unsupported",
}
