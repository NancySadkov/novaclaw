import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "@novaclaw/core/permission"
import { whollyDisabled } from "@novaclaw/core/tool/registry"

/**
 * The horizon filter used to see only the agent's OWN ruleset. The mode overlay, the two Tuning
 * switches and the unattended stance were added later, inside `evaluateInput`, so an Analyze
 * (`plan`) session advertised `bash`, `js`, `trash`, `provision`, `revert` … and refused every call
 * — roughly 7 KB of schema per turn for capabilities that could never fire, the exact
 * advertise-then-refuse fault `registry.ts` claims none of its filters commits. `horizonLayers` is
 * the one composition both the evaluator and the runner's `materialize` call now read.
 */
const horizon = (input: Partial<Parameters<typeof PermissionV2.horizonLayers>[0]>) =>
  PermissionV2.horizonLayers({ agent: undefined, mode: "bypass", resolved: {}, rootType: "interactive", ...input })
/** What `materialize` asks of the layers: withdrawn when ANY layer wholly disables the action. */
const withdrawn = (action: string, layers: ReadonlyArray<PermissionV2.Ruleset>) =>
  layers.some((layer) => whollyDisabled(action, layer))

describe("the tool horizon sees what the evaluator will refuse", () => {
  test("🔴 Analyze withdraws the tools it always refuses, and keeps the ones its carve-out allows", () => {
    const rules = horizon({ mode: "plan" })
    for (const action of ["bash", "js", "trash", "provision", "revert"])
      expect(withdrawn(action, rules), action).toBe(true)
    // A review may still save its report: the allows on the temp dir land after the denies, so
    // these are refused on most targets but NOT withdrawn from the horizon.
    for (const action of ["edit", "write", "create", "external_directory_write"])
      expect(withdrawn(action, rules), action).toBe(false)
  })

  test("Build (bypass) withdraws nothing by mode alone; the agent's own wildcard deny still does", () => {
    expect(["bash", "edit", "write"].some((action) => withdrawn(action, horizon({})))).toBe(false)
    const agent = [{ action: "bash", resource: "*", effect: "deny" as const }]
    // The agent floor's wildcard deny survives Build's wildcard ALLOW: layers, not one findLast.
    expect(withdrawn("bash", horizon({ agent }))).toBe(true)
  })

  test("the Tuning switches and the unattended stance narrow the horizon the way they narrow the verdict", () => {
    expect(withdrawn("write", horizon({ resolved: { surgicalEdits: true } }))).toBe(true)
    expect(withdrawn("edit", horizon({ resolved: { surgicalEdits: true } }))).toBe(false)
    expect(withdrawn("external_directory_write", horizon({ rootType: "auto-prompting" }))).toBe(true)
    expect(withdrawn("external_directory_write", horizon({ rootType: "auto-prompting", mode: "yolo" }))).toBe(false)
  })
})
