/**
 * WHICH SCRATCH GRANTS BELONG TO AN AGENT — the rule, in one place.
 *
 * 🔴 **Why this lives here and not in the agent plugin.** The rule is needed on both sides of the
 * process boundary: the kernel applies it when it materializes an agent's ruleset, and the roster's
 * clone action applies it when it copies an officer's record into a new identity. The tempting host
 * was `plugin/agent.ts`, and it is a trap — that module's graph reaches `agent/avatar.ts`, which
 * imports bundled `.webp` portraits through Bun's file-loader with `@ts-expect-error` directives that
 * only hold under the core tsconfig. Importing the plugin from the app therefore breaks the app and
 * desktop typechecks (`TS2578: Unused '@ts-expect-error' directive`) without a single line of avatar
 * code changing. A helper that two planes share must sit in a module neither plane's tsconfig
 * disagrees about. Hence: `path`, `Scratch`, and a type-only Permission import — nothing else.
 *
 * The rule itself: an agent's private scratch is granted to THAT agent, derived from its id, and a
 * grant naming a DIFFERENT agent's scratch is not this agent's to hold. See `ownScratchGrants` for why
 * both halves have to happen together.
 */
import path from "node:path"
import type { Permission } from "@novaclaw/schema/permission"
import { Scratch } from "../scratch"

const SCRATCH_GRANT_ACTIONS = ["external_directory_read", "external_directory_write"]

/**
 * Rewrite a ruleset's scratch grants so they name THIS agent's own workspace, and nothing else's.
 *
 * A stored layer can carry a grant that was minted for a different id — `floor({ scratchDirs:
 * scratchDirsFor(id) })` bakes a literal path, so anything that copies a resolved record (a clone, an
 * export/import round-trip) carries another officer's private folder along. Measured on a live
 * instance 2026-09-10: `geryon` held `…/scratch/daedalus/*`, which let it write a colleague's notes
 * and refused its own — the opposite of what its system prompt promises.
 *
 * ⚠️ **Both halves are load-bearing.** Granting without stripping fixes the promise and leaves the
 * cross-officer access open; stripping without granting turns a leak into a refusal, which is worse
 * for the operator because it looks like a security fix. So this filters, then grants.
 *
 * Only grants UNDER the scratch root are touched. The other shared locations in the floor (the system
 * temp root, the truncation store) pass through untouched, so this never narrows what the floor meant
 * to give. A residual limitation, named rather than hidden: a foreign grant recorded under a DIFFERENT
 * data root — a config imported from another machine — is not recognized here, because the root is the
 * containment boundary this function is allowed to reason about.
 */
export function ownScratchGrants(agentID: string, rules: readonly Permission.Rule[]): Permission.Rule[] {
  const own = `${Scratch.forAgent(agentID).replaceAll("\\", "/")}/*`
  const root = `${Scratch.root().replaceAll("\\", "/")}/`
  const kept = rules.filter((rule) => {
    if (!SCRATCH_GRANT_ACTIONS.includes(rule.action)) return true
    const resource = String(rule.resource)
    if (!resource.startsWith(root)) return true
    return resource === own
  })
  if (kept.some((rule) => rule.action === "external_directory_write" && String(rule.resource) === own)) return kept
  return [
    ...kept,
    { action: "external_directory_read", resource: own, effect: "allow" },
    { action: "external_directory_write", resource: own, effect: "allow" },
  ]
}
