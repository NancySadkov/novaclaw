import type { TranslationKey } from "@/context/language"
import type { InstalledPolicy } from "@/utils/policy-api"

/**
 * **The decisions the folder-policy surface makes, out of the JSX.**
 *
 * The gap: *"a folder's policy list is READ-ONLY in the app — wants the section-scoped
 * write Permissions got."* Settings could already say which checks are installed and switch one off
 * for the whole instance; the one thing it could not do was change the list a `novaclaw.json` asks
 * for, which left "edit the JSON by hand" as the only route — the *poke memory bytes* principle 12
 * refuses.
 *
 * 🔴 **Three rules here fail SILENTLY when they are wrong**, which is why they are a module rather
 * than three `.filter(…)` chains in a JSX body. They are the policy-shaped restatement of what
 * `project-permissions.ts` records for the rules half:
 *
 *  1. **A folder may only ever ADD.** The gate's applicability filter is
 *     `alwaysOn(provider) || wanted.has(provider.id)`, so this list has no spelling at all for
 *     *"do not run that one here"* — and it must not grow one, because a folder able to remove a
 *     guard the instance installed is a cloned repository disarming the user's rails. Everything
 *     this surface offers is therefore an add, and the copy says so before the control.
 *  2. **Asking for an ALWAYS-ON policy is not nothing, and the copy has to say what it is.** While
 *     the policy is switched on it changes nothing. If the user ever switches it off in Settings,
 *     every tool call in this folder is refused — a folder that asked to be guarded and is not gets
 *     a refusal rather than an unpoliced run. That is the safe direction and a legitimate thing to
 *     declare (*never run me unpoliced*), but nobody predicts it from a tick box, so it is stated at
 *     the control. ⚠️ An earlier version instead REFUSED to write such an id. That was wrong twice:
 *     naming one is opting in, which a folder may do — and since `ToolPolicy.alwaysOn` defaults to
 *     true and neither shipped policy opts out, it made this surface unable to write any id naming
 *     anything installed, which is a write surface that cannot write.
 *  3. **An id nobody here installs REFUSES EVERY TOOL CALL in the folder, immediately.** Same kernel
 *     rule, arrived at now rather than conditionally. It is still a legitimate declaration — the
 *     policy may be installed on a colleague's machine and the file travels — so it is written, and
 *     the consequence is said before the button rather than in a receipt afterwards.
 *
 * ⚠️ **No copy of the id GRAMMAR lives here.** `packages/app` deliberately does not depend on
 * `@novaclaw/schema`, and the better reason than the dependency is that this UI may be driving a
 * REMOTE instance on a different build — a rule compiled into the renderer could disagree with the
 * machine being written to. So the client never pre-judges an id's shape: it sends what the user
 * declared and the server reports what it dropped in `refusedPolicies`, the same division
 * `projectPermissionsPayload` states for an `allow` rule.
 */

/**
 * What a save would do to the folder's list.
 *
 * ⚠️ There is deliberately no `omitted` here, where `ProjectPermissionPlan` has one: every id this
 * surface can hold is writable. The only entry the server drops is one that is not ID-SHAPED, and
 * this renderer does not own that grammar (see the header) — it comes back in the receipt.
 */
export interface ProjectPolicyPlan {
  /** Every id the surface holds, in file order. */
  readonly declared: readonly string[]
  /** Of those, what the write is expected to record — the same list, with duplicates collapsed. */
  readonly persisted: readonly string[]
}

/**
 * What a save will write, given the folder's list.
 *
 * ⚠️ Duplicates collapse, because the gate reads this list into a `Set`: a repeated id is already
 * nothing to the reader, and leaving one in the file makes every surface that lists the section say
 * one name twice. The server collapses them too — this is the preview agreeing with it, not the
 * enforcement.
 */
export function planProjectPolicies(declared: readonly string[]): ProjectPolicyPlan {
  const persisted: string[] = []
  for (const id of declared) if (!persisted.includes(id)) persisted.push(id)
  return { declared, persisted }
}

/**
 * The payload for a folder-policy save.
 *
 * ⚠️ Sends `declared`, not `persisted` — deliberately, and for `projectPermissionsPayload`'s reason:
 * the SERVER decides what may be recorded and reports what it dropped. A client that pre-filtered
 * would make `refusedPolicies` permanently empty, which is the client agreeing with itself instead
 * of being told.
 *
 * ⚠️ An empty list becomes a `clear`, never `policies: []`. `[]` and no key at all read the same to
 * the kernel, and a `"policies": []` line left behind after the user removed their last entry says
 * exactly what no line says — worse, on a later visit it reads as *"someone configured this folder
 * to ask for nothing"* rather than *"nobody has asked for anything"*.
 */
export function projectPoliciesPayload(plan: ProjectPolicyPlan): {
  readonly policies?: readonly string[]
  readonly clear?: readonly "policies"[]
} {
  if (plan.declared.length === 0) return { clear: ["policies"] }
  return { policies: plan.declared }
}

/**
 * How one entry in the folder's list stands against what is installed here.
 *
 * 🔴 Four states, not two, because the remedy differs in each and three of them are things a person
 * has to act on. `GET /api/policy` already separates `missing` from `disabledButRequested` for
 * exactly this reason; this is the same split applied per row so the list itself explains itself.
 */
export type FolderPolicyStatus =
  /** Installed, opt-in, switched on: this is what the section is FOR. */
  | "running"
  /** Installed and opt-in, but switched off in Settings — which refuses every tool call here. */
  | "switched-off"
  /** Not installed here at all — which also refuses every tool call here, fail-closed. */
  | "missing"
  /**
   * Installed and running in every folder anyway.
   *
   * Asking for it changes nothing WHILE it is switched on, and turns every tool call in this folder
   * into a refusal if it is ever switched off in Settings. That is what the user is choosing.
   */
  | "always-on"

export function folderPolicyStatus(id: string, installed: readonly InstalledPolicy[]): FolderPolicyStatus {
  const entry = installed.find((item) => item.id === id)
  if (!entry) return "missing"
  if (entry.alwaysOn) return "always-on"
  return entry.enabled ? "running" : "switched-off"
}

/**
 * The installed policies a folder could still ask for — what the picker offers (principle 12b).
 *
 * ⚠️ EVERY installed policy not already listed, always-on ones INCLUDED. Filtering those out was the
 * first version and it emptied the picker completely, because `ToolPolicy.alwaysOn` defaults to true
 * and neither shipped policy opts out — a picker that can never offer anything is not a picker. What
 * asking for an always-on one costs is said in its row instead of hidden by omitting it.
 */
export function policyAddOptions(
  installed: readonly InstalledPolicy[],
  current: readonly string[],
): readonly InstalledPolicy[] {
  const held = new Set(current)
  return installed.filter((entry) => !held.has(entry.id))
}

/**
 * Whether a hand-typed id is worth offering to add.
 *
 * ⚠️ Emptiness and a duplicate, and nothing else. The GRAMMAR is not checked here — see the header:
 * this renderer may be pointed at an instance on another build, and the server reports what it
 * dropped. What this prevents is only the two cases that are wrong on any build.
 */
export function policyIDIsAddable(value: string, current: readonly string[]): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && !current.includes(trimmed)
}

/**
 * Every key this surface can ask for, for the test that pins them against `en.ts`.
 *
 * ⚠️ A missing key does not throw — `t()` hands back the key behind a signature claiming `string`,
 * so a user reads `policies.folder.edit.save` where a sentence should be. The type check catches a
 * key that was never in `en`; this list catches one removed from it later.
 */
export const projectPolicyKeys: readonly TranslationKey[] = [
  "policies.folder.edit.title",
  "policies.folder.edit.description",
  "policies.folder.edit.narrowing",
  "policies.folder.edit.elsewhere",
  "policies.folder.edit.empty",
  "policies.folder.edit.remove",
  "policies.folder.edit.add",
  "policies.folder.edit.addPlaceholder",
  "policies.folder.edit.addFallback",
  "policies.folder.edit.nothingToOffer",
  "policies.folder.edit.alwaysOnCost",
  "policies.folder.edit.preview",
  "policies.folder.edit.previewClear",
  "policies.folder.edit.save",
  "policies.folder.edit.saving",
  "policies.folder.edit.receipt.refused",
  // The shared receipt renderer's own keys, listed here too because this section is now one of its
  // four callers and a key removed from `en` would blank the line under a save this control made.
  "settings.permissions.project.receipt.preserved",
  "settings.permissions.project.receipt.preservedNone",
  "policies.folder.edit.status.running",
  "policies.folder.edit.status.switchedOff",
  "policies.folder.edit.status.missing",
  "policies.folder.edit.status.alwaysOn",
]
