import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PermissionActions } from "@novaclaw/core/permission-actions"

/**
 * The gate vocabulary is DERIVED here and only DECLARED there.
 *
 * 🔴 A hand-written list of what the product gates is worth exactly as much as the thing that stops
 * it rotting. Actions come from two places and nowhere else: the `action:` a tool asserts, and the
 * `action:` a compiled ruleset names. This re-reads both and fails when either names one the list
 * does not — so adding a tool with a new gate, or a mode rule over a new verb, is a red test rather
 * than a control that silently stops offering the thing it was added for.
 *
 * ⚠️ A SOURCE scan, not a runtime one, and deliberately: enumerating tools at runtime means building
 * the whole registry layer, and the list's whole job is to be available to a UI that has no session,
 * no instance and no registry. The same trade `legacy-path-ledger` and `plan-citation-ledger` make.
 */
const ROOT = path.resolve(import.meta.dir, "..")

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1")

const actionsIn = (file: string): string[] => {
  const source = stripComments(fs.readFileSync(path.join(ROOT, file), "utf8"))
  // The two ways source names an action: the `action:` field of a rule or an assert, and the first
  // argument of a direct `evaluate(...)`. The second is how the one out-of-package caller spends
  // `task`, and leaving it out made this scan miss a gate that genuinely fires.
  const found = [
    ...[...source.matchAll(/action:\s*"([a-zA-Z_.\-]+)"/g)].map((match) => match[1]!),
    ...[...source.matchAll(/(?:^|[^\w.])evaluate\(\s*"([a-zA-Z_.\-]+)"/g)].map((match) => match[1]!),
  ]
  // `action: name` is the idiom for a tool whose gate IS its registered name.
  if (/action:\s*name\b/.test(source)) {
    const declared = source.match(/export const name = "([a-zA-Z_.\-]+)"/)
    if (declared) found.push(declared[1]!)
  }
  return found
}

const files = (dir: string): string[] =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `${dir}/${name}`)

/** Every action a built-in tool asserts. */
const toolActions = new Set(files("src/tool").flatMap(actionsIn))

/** Every action a compiled ruleset names — the floors, the mode overlays, the switches, the stance. */
const RULE_SOURCES = [
  "src/permission.ts",
  "src/session/config-resolve.ts",
  "src/plugin/agent.ts",
  "src/session/runner/short-chat.ts",
]

/**
 * ⚠️ The OTHER tool directory, outside this package. `novaclaw/src/tool/` holds the tools that need
 * an instance, and one of them — `truncate.ts` — is the last caller that spends `task`. Scanning it
 * is what makes "this action still fires" a claim this test checks rather than a sentence in a
 * comment: when that caller goes, `task` leaves the vocabulary and the list goes red until it does.
 */
const ruleActions = new Set([...RULE_SOURCES, ...files("../novaclaw/src/tool")].flatMap(actionsIn))

describe("the permission gate vocabulary", () => {
  test("the scan is real — it finds the actions we know are there", () => {
    // Non-vacuity: an empty scan would make every assertion below pass forever.
    expect(toolActions.size).toBeGreaterThan(15)
    expect(ruleActions.size).toBeGreaterThan(15)
    expect(toolActions.has("websearch")).toBe(true)
    expect(ruleActions.has("external_directory_write")).toBe(true)
  })

  test("🔴 every action a TOOL asserts is offered", () => {
    const missing = [...toolActions].filter((action) => !PermissionActions.ALL.includes(action)).sort()
    expect(
      missing,
      "a tool gates on these and the rule editor would not offer them — add each to permission-actions.ts",
    ).toEqual([])
  })

  test("🔴 every action a compiled RULE names is offered", () => {
    // A rule naming an action the editor cannot offer is the same fault from the other side: the
    // user can be REFUSED for something they cannot write a rule about.
    const missing = [...ruleActions].filter((action) => !PermissionActions.ALL.includes(action)).sort()
    expect(missing, "a compiled ruleset names these — add each to permission-actions.ts").toEqual([])
  })

  test("the list only names things that exist — no aspirational entries", () => {
    // The other direction: an action nothing asserts and no rule names is a row the user is invited
    // to write a rule about that can never fire. `question` was exactly that until it was removed,
    // and `doom_loop` is one today — a config key with a translated Settings row and no evaluator.
    const known = new Set([...toolActions, ...ruleActions])
    expect(PermissionActions.ALL.filter((action) => !known.has(action)).sort()).toEqual([])
  })

  test("the groups partition the list, with no duplicate and nothing lost", () => {
    const grouped = Object.values(PermissionActions.GROUPS).flatMap((group) => [...group])
    expect(new Set(grouped).size, "an action is in two groups").toBe(grouped.length)
    expect([...PermissionActions.ALL].sort()).toEqual([...grouped].sort())
  })
})
