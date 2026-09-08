import type { TranslationKey, Translator } from "@/context/language"
import { confinementState, type ShellStatusWithJail } from "./confinement-state"

const KEYS = {
  none: "settings.project.excludeNone",
  sandboxed: "settings.project.excludeDetail.sandboxed",
  unavailable: "settings.project.excludeDetail.unavailable",
  unknown: "settings.project.excludeDetail.unknown",
} as const satisfies Record<string, TranslationKey>

export const projectExclusionCopyKeys: readonly TranslationKey[] = Object.values(KEYS)

/**
 * The one-line, mechanism-matched account of a project's exclusion list.
 *
 * The shell posture is the instance's own `GET /shell/status` answer. This renderer does not infer
 * confinement from the client platform: the UI and the instance may be on different machines.
 */
export function projectExclusionCopy(input: {
  readonly count: number
  readonly shellStatus: ShellStatusWithJail | undefined
  readonly t: Translator
}): string {
  if (input.count === 0) return input.t(KEYS.none)

  const posture = confinementState(input.shellStatus)
  if (posture.kind === "confined") return input.t(KEYS.sandboxed)
  if (posture.kind === "unknown" || posture.kind === "unreported") return input.t(KEYS.unknown)
  return input.t(KEYS.unavailable)
}
