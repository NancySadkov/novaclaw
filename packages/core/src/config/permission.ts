export * as ConfigPermission from "./permission"

import { Schema, SchemaGetter } from "effect"

export const Action = Schema.Literals(["ask", "allow", "deny"]).annotate({ identifier: "PermissionActionConfig" })
export type Action = Schema.Schema.Type<typeof Action>

export const Object = Schema.Record(Schema.String, Action).annotate({ identifier: "PermissionObjectConfig" })
export type Object = Schema.Schema.Type<typeof Object>

export const Rule = Schema.Union([Action, Object]).annotate({ identifier: "PermissionRuleConfig" })
export type Rule = Schema.Schema.Type<typeof Rule>

// Known permission keys get explicit types in the Effect schema for generated
// docs/types. Runtime config parsing uses Effect's `propertyOrder: "original"`
// parse option so user key order is preserved for permission precedence.
//
// ⚠️ The rest record below keeps this an OPEN namespace on purpose, and that is load-bearing rather
// than lax: a permission action can be an MCP tool's own name or a name a model invented at runtime
// via `tool/define-tool.ts`, so an unknown key must be accepted (B4c's whole premise — see
// `permission.ts` → AMBIENT_SAFE_BASELINE). The consequence is that a key naming an action nothing
// spends is silently inert, and no mechanical check can tell that apart from a legitimate ad-hoc
// action. So the named list is the only place a *retired* key can be answered, which is why it is
// kept honest rather than left to accumulate.
//
// `glob` and `grep` were removed on 2026-07-30 when both tools were remapped onto the `explore`
// action (`Tool.withPermission` in `tool/glob.ts` / `tool/grep.ts`), so that ONE rule governs both
// the execution gate and the model's horizon. Before that they were governed by two actions at once
// and every ruleset had to grant both. Two consequences, recorded here because this is where the
// next reader will come looking:
//   · `explore` now hides both tools as well as refusing them. That direction is strictly more
//     honest — `explore: "deny"` used to deny execution while leaving both ADVERTISED, i.e. ruling
//     2's *a fault is never described falsely*, on a permission surface.
//   · `glob: "deny"` / `grep: "deny"` in a hand-authored config becomes a NO-OP. That direction
//     WIDENS what an agent may do, silently, so it is owed a user-visible release note — it is not
//     owed an on-read translation to `explore`, which is precisely the back-compat shim
//     design-principle #1 forbids and which the standing *no on-read migration* decision rules out.
// `list` went with them: nothing in the tree registers a `list` tool, asserts a `list` action or
// evaluates one — it was granted in exactly one place (the legacy `packages/novaclaw/src/agent`
// service) for a gate that does not exist.
// ⚠️ Two places outside this file still name the retired keys and are NOT fixed by removing them
// here: `packages/novaclaw/src/cli/cmd/agent.ts`'s `AVAILABLE_PERMISSIONS` still offers `glob`/`grep`
// to whoever runs `novaclaw agent create`, and `packages/novaclaw/src/agent/agent.ts` still grants
// `grep`/`glob`/`list` on its legacy `explore` agent. Both are on the legacy path — that CLI writes a
// SINGULAR `permission:` frontmatter key while the V2 markdown-agent decoder reads `permissions`
// (`core/src/config/agent.ts`), so its output has never reached a V2 agent at all — but the stale
// offer is its own legibility fault and is tracked separately, not silently inherited from here.
//
// ⚠️ `task` STAYS, and is not a V2 action. Nothing on the V2 path spends it, but it is live on the
// legacy path — `packages/novaclaw/src/tool/truncate.ts` calls `evaluate("task", "*", …)` to choose
// a truncation hint, `agent/subagent-permissions.ts` reads `task` rules to decide a default deny,
// and `cli/cmd/agent.ts` offers it to users in `AVAILABLE_PERMISSIONS`. Removing the documented key
// for a gate that still fires would be the wrong direction; it goes when that island does.
const InputObject = Schema.StructWithRest(
  Schema.Struct({
    read: Schema.optional(Rule),
    edit: Schema.optional(Rule),
    explore: Schema.optional(Rule),
    bash: Schema.optional(Rule),
    task: Schema.optional(Rule),
    external_directory: Schema.optional(Rule),
    todowrite: Schema.optional(Action),
    resource_status: Schema.optional(Action),
    question: Schema.optional(Action),
    webfetch: Schema.optional(Action),
    websearch: Schema.optional(Action),
    doom_loop: Schema.optional(Action),
    skill: Schema.optional(Rule),
  }),
  [Schema.Record(Schema.String, Rule)],
)

const InputSchema = Schema.Union([Action, InputObject])

const normalizeInput = (input: Schema.Schema.Type<typeof InputSchema>): Schema.Schema.Type<typeof InputObject> =>
  typeof input === "string" ? { "*": input } : input

export const Info = InputSchema.pipe(
  Schema.decodeTo(InputObject, {
    decode: SchemaGetter.transform(normalizeInput),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "PermissionConfig" })
type _Info = Schema.Schema.Type<typeof InputObject>
export type Info = { -readonly [K in keyof _Info]: _Info[K] }

function normalizeAction(action: string) {
  return action === "write" || action === "patch" ? "edit" : action
}

// Lower the ergonomic permission dict (used in config authoring and inline `Permission.fromConfig`
// calls) into the ordered V2 `Permission.Ruleset` shape consumed by `Config.Info.permissions` and
// each agent's `permissions`. An optional legacy `tools` map (a `{ tool: boolean }` allow/deny record)
// is expanded first; write/patch collapse onto `edit`.
export function ruleset(info?: Info, tools?: Readonly<Record<string, boolean>>) {
  const rules: Array<{ action: string; resource: string; effect: Action }> = globalThis.Object.entries(tools ?? {}).map(
    ([action, enabled]) => ({
      action: normalizeAction(action),
      resource: "*",
      effect: enabled ? ("allow" as const) : ("deny" as const),
    }),
  )
  for (const [action, rule] of globalThis.Object.entries(info ?? {})) {
    if (!rule) continue
    if (typeof rule === "string") {
      rules.push({ action, resource: "*", effect: rule })
      continue
    }
    rules.push(...globalThis.Object.entries(rule).map(([resource, effect]) => ({ action, resource, effect })))
  }
  return rules.length ? rules : undefined
}
