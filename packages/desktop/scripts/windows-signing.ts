/**
 * Would a Windows build sign, and if not, may it still package?
 *
 * 🔴 **NC-SEC-010 — a RELEASE build that could not sign must not package.** The signing callback in
 * `electron-builder.config.ts` returned silently unless it was on Windows under
 * `GITHUB_ACTIONS=true`, and electron-builder has no force-signing requirement to contradict it. So
 * `beta`/`prod` packaged to a normal `.7z` with no authenticated publisher, and every later
 * hash/SBOM/release-record step ran green over it. One missing secret, one renamed CI variable, or
 * one local emergency build was enough.
 *
 * ⚠️ **The build LOG cannot tell you, and that is why this survived.** electron-builder prints
 * `• signing with signtool.exe path=…` BEFORE it calls the signer — 267 of those lines in the 0.1.67
 * Windows build, with nothing signed. Reading that log is how a reviewer concludes a build "signed
 * everything"; only a guard distinguishes the two cases, because the log says the same words either
 * way.
 *
 * ⚠️ Its OWN module, not a named export from the config. Exporting it from there made TypeScript
 * demand an explicit annotation on the config's inferred default export (TS2742), and a pure rule
 * should not be able to break the file it guards.
 */

/** What a build should do about Windows code signing. */
export type SigningVerdict =
  /** On Windows in CI: the real signer runs. */
  | "signs"
  /** Nothing to sign (not Windows), or a dev build, which is never published. */
  | "skip-allowed"
  /** A release channel that cannot sign — refuse to package rather than ship unsigned. */
  | "refuse"

export function windowsSigning(input: {
  readonly channel: string
  readonly platform: string
  readonly githubActions: string | undefined
}): SigningVerdict {
  if (input.platform !== "win32") return "skip-allowed"
  if (input.githubActions === "true") return "signs"
  /**
   * ⚠️ By CHANNEL, not by "am I in CI". A beta cut on somebody's laptop is precisely the emergency
   * build this exists to catch, and it is not in CI by definition.
   *
   * ⚠️ `dev` is exempt deliberately. Dev builds are made locally all day and are never published;
   * failing them would make this something people route around, which is how a release guard stops
   * being one.
   */
  return input.channel === "dev" ? "skip-allowed" : "refuse"
}
