import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Tool } from "@novaclaw/core/tool/tool"
import { ColleagueTool } from "@novaclaw/core/tool/colleague"
import { SystemCompose } from "@novaclaw/core/session/runner/system-compose"

/**
 * WITHHELD AT THE CAP, NOT ADVERTISED AND REFUSED.
 *
 * Our own standing constraint — *a wholly denied tool is withdrawn, never advertised and refused* —
 * applied one level down. At `HOP_CAP` the asking ops cannot succeed, so offering them spends a turn
 * on a refusal the model then has to interpret. `list`, `hire` and `retire` have nothing to do with
 * the bound and stay, which is why this is a VARIANT rather than withholding the tool.
 *
 * ⚠️ The item's falsification is BOTH halves: *"a turn at the cap must show no `ask` op in its tool
 * definitions AND a prompt line saying why; if only one of the two lands, the item is not done."*
 */

const json = (schema: Schema.Top) => JSON.stringify(Schema.toJsonSchemaDocument(schema))

describe("what a capped turn is offered", () => {
  test("the ordinary input offers the asking ops", () => {
    // The control. Without it a variant that dropped everything would look like success.
    const full = json(ColleagueTool.Input)
    expect(full).toContain("ask_group")
    expect(full).toContain("hire")
  })

  test("🔴 the capped input offers NO asking ops", () => {
    const capped = json(ColleagueTool.CappedInput)
    expect(capped).not.toContain("ask_group")
    expect(capped).not.toContain('"ask"')
  })

  test("…and still offers what the bound has nothing to do with", () => {
    // The whole reason this is a variant rather than withholding `colleague`: a chain that is too
    // long says nothing about whether Nova may see the roster or retire somebody.
    const capped = json(ColleagueTool.CappedInput)
    expect(capped).toContain("list")
    expect(capped).toContain("hire")
    expect(capped).toContain("retire")
    expect(capped).toContain("set_superior")
  })
})

describe("the variant mechanism itself", () => {
  const withVariants = Tool.make({
    description: "demo",
    input: Schema.Union([Schema.Struct({ op: Schema.Literal("keep") }), Schema.Struct({ op: Schema.Literal("drop") })]),
    output: Schema.Struct({ ok: Schema.Boolean }),
    variants: { narrow: Schema.Union([Schema.Struct({ op: Schema.Literal("keep") })]) },
    execute: () => ({ ok: true }) as never,
  })

  test("a variant narrows what is advertised", () => {
    expect(JSON.stringify(Tool.definition("demo", withVariants, "narrow"))).not.toContain("drop")
    expect(JSON.stringify(Tool.definition("demo", withVariants))).toContain("drop")
  })

  test("it is CACHED per variant, not recomputed", () => {
    // The cost objection the item raised — a per-turn schema build on the hot path. Keyed on name
    // AND variant, so a variant is one extra `toJsonSchema` per process.
    expect(Tool.definition("demo", withVariants, "narrow")).toBe(Tool.definition("demo", withVariants, "narrow"))
    expect(Tool.definition("demo", withVariants, "narrow")).not.toBe(Tool.definition("demo", withVariants))
  })

  test("an unknown variant falls back to the full schema rather than an empty one", () => {
    // A typo must not silently offer a model nothing at all.
    expect(JSON.stringify(Tool.definition("demo", withVariants, "nonsense"))).toContain("drop")
  })

  test("a tool that declares no variants is unaffected", () => {
    const plain = Tool.make({
      description: "plain",
      input: Schema.Struct({ x: Schema.String }),
      output: Schema.Struct({ ok: Schema.Boolean }),
      execute: () => ({ ok: true }) as never,
    })
    expect(JSON.stringify(Tool.definition("plain", plain, "capped"))).toBe(
      JSON.stringify(Tool.definition("plain", plain)),
    )
  })
})

describe("and the prompt says WHY", () => {
  test("🔴 a capped turn is told the ops are missing on purpose", () => {
    // Withholding alone teaches nothing: a model that cannot see `ask` does not conclude "the chain
    // is too long", it concludes nothing and tries something else. The refusal text used to carry
    // that lesson, and withholding removes the refusal — so the sentence has to move here.
    const text = SystemCompose.delegationSection({
      canSpawn: false,
      canAddressColleagues: true,
      colleaguesAtCap: true,
    })
    expect(text).toBeDefined()
    expect(text!).toMatch(/cannot ASK a colleague/i)
    // Names the way out, which is the same remedy the bound's own refusal names.
    expect(text!).toContain("user")
    // …and says what is still possible, so the absence does not read as the tool being broken.
    expect(text!).toContain("list")
  })

  test("an uncapped turn is told none of it", () => {
    const text = SystemCompose.delegationSection({ canSpawn: false, canAddressColleagues: true })
    expect(text!).not.toMatch(/cannot ASK a colleague/i)
  })

  test("a turn with no colleague access at all is not told about a cap", () => {
    // The cap is a fact about a chain, not about permission. Explaining it to a session that could
    // never address anybody is noise that reads as a denial.
    const text = SystemCompose.delegationSection({
      canSpawn: true,
      canAddressColleagues: false,
      colleaguesAtCap: true,
    })
    expect(text ?? "").not.toMatch(/cannot ASK a colleague/i)
  })
})
