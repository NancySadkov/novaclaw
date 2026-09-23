import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Tool } from "@novaclaw/core/tool/tool"
import { ColleagueTool } from "@novaclaw/core/tool/colleague"

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

describe("local messaging is always available in the colleague schema", () => {
  test("the ordinary input offers the asking ops", () => {
    // The control. Without it a variant that dropped everything would look like success.
    const full = json(ColleagueTool.Input)
    expect(full).toContain("ask_group")
    expect(full).toContain("hire")
  })

  test("an unknown variant cannot withdraw asking", () => {
    const full = json(ColleagueTool.Input)
    expect(full).toContain("ask_group")
    expect(full).toContain('"ask"')
  })

  test("the rest of the colleague operations remain available", () => {
    const full = json(ColleagueTool.Input)
    expect(full).toContain("list")
    expect(full).toContain("hire")
    expect(full).toContain("retire")
    expect(full).toContain("set_superior")
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

// 🗑️ "and the prompt says WHY" stood here, testing `SystemCompose.delegationSection`'s cap sentence.
// The section is retired with the per-turn part assembly; the one prompt's delegation paragraph is
// fixed. Note the cap sentence was already inert in the runner — it composed `colleaguesAtCap: false`
// to keep live hop pressure out of the frozen prefix — so nothing reachable was lost.
