import { ConfigPermission } from "@novaclaw/core/config/permission"
import { Wildcard } from "@novaclaw/core/util/wildcard"
import os from "os"
import { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"

// ⚠️ **The permission SERVICE was deleted from this file 2026-08-06** — `Interface`, `Service`,
// `layer`, `defaultLayer` and `node`, plus the two graph registrations that were its only references
// (`effect/app-runtime.ts`, `server/routes/instance/httpapi/server.ts`). It was constructed at boot in
// both graphs and obtained by nothing. The LIVE gate is `packages/core/src/permission.ts`, a different
// module with the same name — that is the one to read, and the one not to confuse this with.
//
// `modeRuleset(mode)` — the V1-coarse permission-MODE overlay — was DELETED here (todo.md *"we
// discard all the cruft"*, v0.2.0-prep Wave 4 §5). It had zero production callers: V2 resolves a
// mode through `core/src/permission.ts`'s `MODE_RULES`, whose action vocabulary is finer than V1's
// (the comment it carried admitted `surgical` was inexpressible in it). Its only caller anywhere was
// the test that asserted its table back to it. The V1 `/permission` HTTP routes went in the same
// commit; what remains in this file is the ruleset algebra that IS still live —
// `evaluate` (skill filtering), `fromConfig`/`merge` (agent defaults).

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
