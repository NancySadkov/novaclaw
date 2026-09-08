import { ConfigPermission } from "@novaclaw/core/config/permission"
import { Wildcard } from "@novaclaw/core/util/wildcard"
import os from "os"
import { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"

// 🔴 **THIS IS NOT THE PERMISSION GATE.** The live gate is `packages/core/src/permission.ts`, a
// different module with the same name — that is the one to read, and the one not to confuse this
// with. What lives here is only the ruleset ALGEBRA: `evaluate` (skill filtering) and
// `fromConfig`/`merge` (agent defaults). Nothing here decides whether a tool call may run.

export const Event = PermissionRuleset.Event

export function evaluate(
  permission: string,
  pattern: string,
  ...rulesets: PermissionRuleset.Ruleset[]
): PermissionRuleset.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermission.Info) {
  const ruleset: PermissionRuleset.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionRuleset.Ruleset[]): PermissionRuleset.Rule[] {
  return rulesets.flat()
}

export * as Permission from "."
