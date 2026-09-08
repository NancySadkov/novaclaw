import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { PermissionActions } from "@novaclaw/core/permission-actions"
import { stripComments } from "./lib/source-scan"

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
    // to write a rule about that can never fire. `question` and `doom_loop` were exactly that; both
    // are gone (2026-09-04) and the config-key test below is what keeps them gone.
    const known = new Set([...toolActions, ...ruleActions])
    expect(PermissionActions.ALL.filter((action) => !known.has(action)).sort()).toEqual([])
  })

  /**
   * 🔴 THE THIRD SOURCE, and the one `doom_loop` came through. `config/permission.ts` names a struct
   * of permission keys for config authoring, generated types and docs — a vocabulary of its own, and
   * until 2026-09-04 nothing tied it to the actions that actually exist. `doom_loop` sat there with a
   * translated Settings string in eighteen locales and no `evaluate("doom_loop", …)` anywhere;
   * `question` outlived the tool it gated. Both were rules a user could write that could never fire.
   *
   * The scan reads only the EXPLICIT struct keys. The trailing `Schema.Record` rest is deliberately
   * open (an MCP tool's action is the remote tool's name, and a model can define a tool at runtime),
   * so an unknown key must stay accepted — which is exactly why the NAMED list is the only place a
   * retired key can be answered.
   */
  const configKeys = (() => {
    const source = stripComments(fs.readFileSync(path.join(ROOT, "src/config/permission.ts"), "utf8"))
    const struct = /const InputObject = Schema\.StructWithRest\(\s*Schema\.Struct\(\{([\s\S]*?)\}\)/.exec(source)
    if (!struct) return []
    return [...struct[1]!.matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_.\-]*):/gm)].map((match) => match[1]!)
  })()

  /**
   * ⚠️ Kept EMPTY on purpose. It held `external_directory` for one day (closed
   * 2026-09-04): the third inert key, deferred because its filing said making it effective would
   * NARROW a live path. It would not have — the rules that authored it lived in
   * `novaclaw/src/agent/agent.ts`, whose ruleset is not the gate, and `packages/core` cannot import
   * `packages/novaclaw`, so nothing this evaluator does could ever have seen them. The deferral was
   * bought by one grep nobody ran.
   *
   * So an entry here is a finding parked, not a key excused. Add one only with a ledger id beside it
   * and a reason that is a measurement rather than a worry.
   */
  const UNSPENT_CONFIG_KEYS: readonly string[] = []

  test("the config-key scan is real — it finds the keys we know are there", () => {
    expect(configKeys.length).toBeGreaterThan(8)
    expect(configKeys).toContain("bash")
    expect(configKeys).not.toContain("external_directory")
    // The three retired keys, so this goes red if any is ever re-added.
    expect(configKeys).not.toContain("doom_loop")
    expect(configKeys).not.toContain("question")
  })

  test("🔴 every CONFIG key names an action that exists", () => {
    // The fault from the authoring side: a key here is what a config file, the generated types and
    // the docs invite a user to write. One naming no action is a switch wired to nothing.
    const known = new Set([...toolActions, ...ruleActions])
    const inert = configKeys
      .filter((key) => !known.has(key) && !PermissionActions.ALL.includes(key))
      .filter((key) => !UNSPENT_CONFIG_KEYS.includes(key))
      .sort()
    expect(
      inert,
      "config/permission.ts names these and nothing evaluates them — a rule a user writes for one can never fire",
    ).toEqual([])
  })

  test("the groups partition the list, with no duplicate and nothing lost", () => {
    const grouped = Object.values(PermissionActions.GROUPS).flatMap((group) => [...group])
    expect(new Set(grouped).size, "an action is in two groups").toBe(grouped.length)
    expect([...PermissionActions.ALL].sort()).toEqual([...grouped].sort())
  })
})
