export * as PermissionActions from "./permission-actions"

/**
 * THE GATE VOCABULARY — every action a permission rule can name, so a control can offer it.
 *
 * 🔴 This exists because a rule editor was asking the user to TYPE one. `settings-v2`'s project
 * permission editor took the action as free text whose only guidance was a placeholder ("What the
 * agent wants to do"), while the vocabulary was compiled into `core` and shown nowhere — and a
 * misspelling saved silently, matched nothing, and reported success. That is principle 12(b)
 * verbatim: *every list-shaped setting offers its list*, and this is the list.
 *
 * ⚠️ **It is not a security boundary and adding to it grants nothing.** The evaluator resolves a
 * rule by matching the action it is given (`Wildcard.match`), so an action absent from here still
 * works when typed — which is exactly why free text stays as the fallback beside the list. What this
 * changes is whether the user has to GUESS.
 *
 * ⚠️ **Kept honest by `permission-actions.test.ts`, not by care.** That test re-derives the set from
 * the two places actions really come from — the `action:` a tool asserts under `core/src/tool/`, and
 * the `action:` a compiled ruleset names (`permission.ts`, `config-resolve.ts`, `plugin/agent.ts`,
 * `short-chat.ts`) — and fails if either names one this list does not. A list a refactor can quietly
 * outgrow is the c64 line with extra steps.
 *
 * ⚠️ What is deliberately NOT here: an MCP tool's action (it IS the remote tool's name, and the set
 * is per-server), and an ad-hoc tool a model defines at runtime. Neither is knowable from source,
 * and both are what the free-text fallback is for.
 */

/** Reading and searching. Ambient on a default install; a project may still narrow them. */
const READ = ["read", "explore"] as const

/** Changing the working tree. Granted by the permission MODE a user picked, never ambiently. */
const MUTATE = ["edit", "write", "create", "trash"] as const

/** Running things. `wait` is `bash`'s sibling for a backgrounded command. */
const EXECUTE = ["bash", "js", "computer", "wait"] as const

/**
 * Reaching outside the session's folder. READ and WRITE are separate actions on purpose: a read
 * grant never authorizes a write (`plugin/agent.ts`'s floor, "1I: external access is CLASSED").
 */
const EXTERNAL = ["external_directory_read", "external_directory_write"] as const

/** The public internet. Both ambient by owner ruling; the airgap policy is the real boundary. */
const NETWORK = ["webfetch", "websearch"] as const

/** The session's own state and the instance's own numbers. No filesystem, no network. */
const SESSION = ["todowrite", "resource_status", "chat_upgrade"] as const

// ⚠️ `doom_loop` is NOT here, and its absence is the point. `config/permission.ts` declares the key
// and the Settings → Permissions tab ships a translated row for it in eighteen locales, but nothing
// in the tree ever calls `evaluate("doom_loop", …)` — it is a switch wired to nothing, which is the
// same fault the `websearch` key had before that gate was built. Offering it here would invite a
// user to write a rule that can never fire. Filed rather than quietly listed.

/** Durable or privileged surfaces: memory, skills, recipes, quality commands, new tools, apps. */
const CAPABILITY = ["kb", "skill", "recipe", "revert", "provision", "define_tool", "register-app"] as const

/** Delegation: staffing sub-agents and handing work to a colleague. */
const DELEGATION = ["spawn", "colleague"] as const

/** The community network and the messengers, which speak as the user to other people. */
const SOCIAL = [
  "community_ask",
  "community_say",
  "messenger.connect",
  "messenger.initiate",
  "messenger.moderate",
  "messenger.send",
] as const

/**
 * Named for completeness because a compiled rule still mentions them, or a live caller still spends
 * them.
 *
 * `plan_enter`/`plan_exit` are denied by every built-in agent's floor. `task` is spent by exactly one
 * caller and it is outside this package — `novaclaw/src/tool/truncate.ts` reads it to choose a
 * truncation hint — which is why the test that derives this list names that file explicitly rather
 * than scanning `core` alone. A rule editor that hid either would be lying about what a rule can
 * name.
 */
const LEGACY = ["plan_enter", "plan_exit", "task"] as const

/** Every action a rule may name, grouped for a control that wants to show them in sections. */
export const GROUPS = {
  read: READ,
  mutate: MUTATE,
  execute: EXECUTE,
  external: EXTERNAL,
  network: NETWORK,
  session: SESSION,
  capability: CAPABILITY,
  delegation: DELEGATION,
  social: SOCIAL,
  legacy: LEGACY,
} as const

export type Group = keyof typeof GROUPS

/**
 * Which group an action belongs to, or `undefined` for one this build has never heard of — which is
 * what a control gets when a user types the name of a plugin's own gate into the free-text fallback.
 */
export const groupOf = (action: string): Group | undefined =>
  (Object.keys(GROUPS) as Group[]).find((group) => (GROUPS[group] as readonly string[]).includes(action))

/**
 * Every action, as a TYPE.
 *
 * `ALL` is annotated `readonly string[]` because its consumers compare it against free text — an
 * MCP action or a runtime-defined tool's name — and a literal union would reject those. This type
 * is the other half: it lets a table be keyed on the closed set, so a control that must have an
 * entry PER ACTION fails to compile when one is added rather than falling back at runtime.
 * `app/src/i18n/permission-action-labels.ts` is the first such table, and it is why the app has no
 * `dynamicKey` hatch for these labels (`i18n/key-typing.test.ts`: narrow the source).
 */
export type Action = (typeof GROUPS)[keyof typeof GROUPS][number]

/** Flat and sorted, for a control that just wants the list. */
export const ALL: readonly string[] = Object.values(GROUPS)
  .flatMap((group) => [...group])
  .sort()
