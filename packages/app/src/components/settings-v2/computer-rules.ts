/**
 * The permission-rule arithmetic behind the Computer Use tab.
 *
 * ⚠️ **It lives in a plain `.ts` beside the component, not inside it, so it can be TESTED.** Importing
 * the `.tsx` pulls Solid's web runtime into the test environment and dies (`Export named 'use' not
 * found`), which is why `models-io.ts` and `memory-bundle.ts` next door have the same shape. The
 * separation is not cosmetic here: the control is a Kobalte dropdown that does not open under a
 * synthetic pointer sequence (verified by hand, 2026-08-06), so a unit test is the ONLY mechanical
 * check these two decisions can get.
 *
 * Both failures they prevent produce a control that LOOKS like it works — the row shows a value, the
 * write returns 200, and the agent's behaviour never changes.
 */

export type PermissionEffect = "allow" | "ask" | "deny"

export interface PermissionRule {
  action?: string
  resource?: string
  effect?: PermissionEffect
}

/** The action this tab governs. */
export const COMPUTER_ACTION = "computer"

/**
 * The effect a ruleset currently gives `computer`.
 *
 * ⚠️ **First match wins, so read the FIRST matching rule and not any matching rule.** The ruleset is
 * ORDERED and the evaluator stops at the first hit; scanning for any mention would report a later,
 * shadowed rule as if it were in force — a settings screen contradicting the system it configures.
 *
 * Absent means **ask**, which is a default rather than an absence: computer use is the one capability
 * where "allow" can mean clicking anything on a real screen.
 */
export const effectOf = (rules: readonly PermissionRule[]): PermissionEffect =>
  rules.find((rule) => rule.action === COMPUTER_ACTION)?.effect ?? "ask"

/**
 * The ruleset after choosing `effect` for `computer`.
 *
 * ⚠️ **REPLACE, never append.** Appending to a first-match-wins list leaves the OLD rule in front and
 * the new one dead. Every other rule keeps its relative order, because the list is ordered and
 * reshuffling unrelated rules would silently re-prioritise them.
 */
export const withEffect = (rules: readonly PermissionRule[], effect: PermissionEffect): PermissionRule[] => [
  { action: COMPUTER_ACTION, resource: "*", effect },
  ...rules.filter((rule) => rule.action !== COMPUTER_ACTION),
]
