import { describe, expect, test } from "bun:test"
import { TaxonomyScaffold } from "@novaclaw/core/session/runner/taxonomy-scaffold"

describe("TaxonomyScaffold.scaffold", () => {
  test("a model rated Fast gets an explicit work-in-small-verified-steps stance", () => {
    // The class a person uses for labeling and searching is the one the harness must not hand a large
    // unverified task to. It is the ONLY class that gets scaffolding.
    expect(TaxonomyScaffold.scaffold("fast")).toContain("SMALL, VERIFIED steps")
  })

  test("Usual, Smart and an unresolved class get no scaffolding", () => {
    // Usual is the mainstream coding/administration model and Smart is deliberately over-provisioned:
    // nagging either trains the model to distrust a plan that is fine.
    expect(TaxonomyScaffold.scaffold("usual")).toBeUndefined()
    expect(TaxonomyScaffold.scaffold("smart")).toBeUndefined()
    expect(TaxonomyScaffold.scaffold(undefined)).toBeUndefined()
  })
})
