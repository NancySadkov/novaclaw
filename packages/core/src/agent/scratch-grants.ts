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
 * code changing. A helper that two planes share must be browser-safe by construction. Hence this
 * module transforms strings and rules only; the kernel caller supplies paths resolved on its host.
 *
 * The rule itself: an agent's private scratch is granted to THAT agent, and a grant naming a
 * DIFFERENT agent's scratch is not this agent's to hold. See `ownScratchGrants` for why both halves
 * have to happen together.
 */
import type { Permission } from "@novaclaw/schema/permission"

const SCRATCH_GRANT_ACTIONS = new Set(["external_directory_read", "external_directory_write"])
const normalized = (resource: unknown) => String(resource).replaceAll("\\", "/").replace(/\/+$/, "")
const directory = (resource: unknown) => normalized(resource).replace(/\/\*$/, "")
const key = (resource: unknown) => {
  const value = normalized(resource)
  return /^(?:[a-z]:|\/\/)/i.test(value) ? value.toLowerCase() : value
}

export function scratchDirectoryGrants(resource: string): Permission.Rule[] {
  const root = directory(resource)
  return [root, `${root}/*`].flatMap((resource) => [
    { action: "external_directory_read", resource, effect: "allow" as const },
    { action: "external_directory_write", resource, effect: "allow" as const },
  ])
}

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
 * data root — a config imported from another machine — is not recognized here, because the supplied
 * root is the containment boundary this function is allowed to reason about.
 */
export function ownScratchGrants(
  rules: readonly Permission.Rule[],
  paths: { readonly root: string; readonly own: string },
): Permission.Rule[] {
  const root = key(paths.root)
  const grants = scratchDirectoryGrants(paths.own)
  const ownResources = new Set(grants.map((rule) => key(rule.resource)))
  const kept = rules.filter((rule) => {
    if (!SCRATCH_GRANT_ACTIONS.has(rule.action)) return true
    const resource = key(rule.resource)
    return ownResources.has(resource) || (resource !== root && !resource.startsWith(`${root}/`))
  })
  const missing = grants.filter(
    (grant) =>
      !kept.some(
        (rule) => rule.action === grant.action && key(rule.resource) === key(grant.resource) && rule.effect === "allow",
      ),
  )
  const firstOwn = kept.findIndex(
    (rule) => SCRATCH_GRANT_ACTIONS.has(rule.action) && ownResources.has(key(rule.resource)),
  )
  kept.splice(firstOwn === -1 ? kept.length : firstOwn, 0, ...missing)
  return kept
}

/**
 * Move a source officer's materialized scratch grants to a cloned identity. The source path came
 * from the instance, so preserving its prefix works when the UI and NovaClaw run on different hosts.
 */
export function retargetScratchGrants(
  sourceAgentID: string,
  targetAgentID: string,
  rules: readonly Permission.Rule[],
): Permission.Rule[] {
  const sourceSuffix = `/scratch/${sourceAgentID}`
  const roots = new Set<string>()
  const kept = rules.filter((rule) => {
    if (!SCRATCH_GRANT_ACTIONS.has(rule.action)) return true
    const resource = directory(rule.resource)
    const root = resource.slice(0, -sourceSuffix.length)
    if (key(resource) !== key(`${root}${sourceSuffix}`)) return true
    roots.add(root)
    return false
  })
  for (const root of roots) {
    kept.push(...scratchDirectoryGrants(`${root}/scratch/${targetAgentID}`))
  }
  return kept
}
