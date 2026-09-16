import { describe, expect, test } from "bun:test"
import { ModelV2 } from "./model"
import { ModelTaxonomy } from "./model-taxonomy"
import { ProviderV2 } from "./provider"

// The ONE conversion from a model's class to a decision. Everything that used to read a benchmark
// percentage — selection (`leastLoaded`), role-fit warnings (`AgentModelFit`), scaffold intensity
// (`TaxonomyScaffold`) and the recall budget (`SessionRecall`) — reads this module, so these tests
// are the contract those four share.

const model = (id: string, taxonomy?: ModelV2.Taxonomy): ModelV2.Info =>
  ModelV2.Info.make({
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make("p"),
    name: id,
    api: { id: ModelV2.ID.make(id), type: "native", settings: {} },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
    ...(taxonomy === undefined ? {} : { taxonomy }),
  })

describe("the class a model is rated as", () => {
  test("an unrated model IS Usual — the default, not a missing value", () => {
    // ⚠️ This is the load-bearing one. If absence resolved to `fast` every hand-added local endpoint
    // would be demoted and warned about; if it resolved to `smart` every unrated model would win
    // every `smart` request. `usual` is the mainstream job, which is what a person means by nothing.
    expect(ModelTaxonomy.of({ taxonomy: undefined })).toBe("usual")
    expect(ModelTaxonomy.of({ taxonomy: "fast" })).toBe("fast")
    expect(ModelTaxonomy.of({ taxonomy: "smart" })).toBe("smart")
  })

  test("rank is fast < usual < smart, and label is the human word", () => {
    expect(ModelTaxonomy.rank("fast")).toBeLessThan(ModelTaxonomy.rank("usual"))
    expect(ModelTaxonomy.rank("usual")).toBeLessThan(ModelTaxonomy.rank("smart"))
    expect(ModelTaxonomy.label("smart")).toBe("Smart")
    expect(ModelTaxonomy.label("usual")).toBe("Usual")
    expect(ModelTaxonomy.label("fast")).toBe("Fast")
  })
})

describe("satisfies — capability is a floor", () => {
  test("the class or above can serve the request", () => {
    expect(ModelTaxonomy.satisfies("smart", "smart")).toBe(true)
    expect(ModelTaxonomy.satisfies("smart", "usual")).toBe(true)
    expect(ModelTaxonomy.satisfies("smart", "fast")).toBe(true)
    expect(ModelTaxonomy.satisfies("usual", "usual")).toBe(true)
    expect(ModelTaxonomy.satisfies("usual", "fast")).toBe(true)
  })

  test("beneath the request cannot, at every rung", () => {
    expect(ModelTaxonomy.satisfies("usual", "smart")).toBe(false)
    expect(ModelTaxonomy.satisfies("fast", "smart")).toBe(false)
    expect(ModelTaxonomy.satisfies("fast", "usual")).toBe(false)
  })
})

describe("fit — exact first, then above, then the shortfall", () => {
  test("an exact match outranks both directions", () => {
    expect(ModelTaxonomy.fit("usual", "usual")).toBeGreaterThan(ModelTaxonomy.fit("smart", "usual"))
    expect(ModelTaxonomy.fit("usual", "usual")).toBeGreaterThan(ModelTaxonomy.fit("fast", "usual"))
  })

  test("over-provisioned is better than under-provisioned, and the nearer is better", () => {
    // A `fast` request served by `usual` beats one served by `smart` (close over far), and both beat
    // anything BELOW the request. This is what keeps load balancing the primary key: class only
    // decides between equally idle models.
    expect(ModelTaxonomy.fit("usual", "fast")).toBeGreaterThan(ModelTaxonomy.fit("smart", "fast"))
    expect(ModelTaxonomy.fit("usual", "fast")).toBeGreaterThan(ModelTaxonomy.fit("fast", "usual"))
    expect(ModelTaxonomy.fit("smart", "usual")).toBeGreaterThan(ModelTaxonomy.fit("fast", "usual"))
  })
})

describe("requestModel — the general 'give me a model for this job'", () => {
  const pool = [model("s", "smart"), model("u", "usual"), model("f", "fast"), model("x", "special"), model("none")]

  test("an undefined request asks nothing, so every AUTO-SELECTABLE candidate is adequate", () => {
    // The pool is the whole catalog for the purposes of this claim; `x` is the one the harness may not
    // pick by itself, so it is absent even here.
    expect(ModelTaxonomy.requestModel({ taxonomy: undefined, available: pool }).map((m) => String(m.id))).toEqual([
      "s",
      "u",
      "f",
      "none",
    ])
  })

  test("a class request returns only what can serve it, unrated models included as Usual", () => {
    const ids = (taxonomy: ModelV2.Requirement | undefined) =>
      ModelTaxonomy.requestModel({ taxonomy, available: pool }).map((m) => String(m.id))
    expect(ids("smart")).toEqual(["s"])
    expect(ids("usual")).toEqual(["s", "u", "none"])
    expect(ids("fast")).toEqual(["s", "u", "f", "none"])
  })

  test("an EMPTY pool is a real answer the caller must handle, not a crash", () => {
    // `leastLoaded` is where this matters: an install with one undersized model must still answer, so
    // it keeps the officer working and lets `AgentModelFit` explain the shortfall.
    expect(ModelTaxonomy.requestModel({ taxonomy: "smart", available: [model("f", "fast")] })).toEqual([])
  })
})

describe("special — a scope marker, not a capability rank", () => {
  test("it satisfies NOTHING, at every rung", () => {
    // Owner ruling: *"Special (wont be used to power agents, unless agent settings explicitly pick
    // it)."* A floor comparison is the first place that has to be false, or `requestModel` and the
    // officer's fit warning would both let it through.
    expect(ModelTaxonomy.satisfies("special", "fast")).toBe(false)
    expect(ModelTaxonomy.satisfies("special", "usual")).toBe(false)
    expect(ModelTaxonomy.satisfies("special", "smart")).toBe(false)
  })

  test("it has the lowest fit for EVERY request, so it can never win a sort tie-break", () => {
    // ⚠️ The claim is per-REQUEST, not across requests. `fit` measures DISTANCE from the wanted class,
    // so `special` versus a `fast` request ties with `fast` versus a `usual` request — both are one
    // step below. What is true, and what a sort needs, is that for a FIXED request nothing scores
    // lower than `special`: `rank(-1)` puts it one step under `fast`, and the shortfall penalty
    // applies on top.
    for (const want of ["smart", "usual", "fast"] as const) {
      const special = ModelTaxonomy.fit("special", want)
      for (const have of ["smart", "usual", "fast"] as const)
        expect(special, `special vs ${have} for a ${want} request`).toBeLessThan(ModelTaxonomy.fit(have, want))
    }
    expect(ModelTaxonomy.rank("special")).toBeLessThan(ModelTaxonomy.rank("fast"))
  })

  test("autoSelectable is false for special alone, and it is what every pool asks", () => {
    expect(ModelTaxonomy.autoSelectable({ taxonomy: "special" })).toBe(false)
    for (const taxonomy of ["smart", "usual", "fast"] as const)
      expect(ModelTaxonomy.autoSelectable({ taxonomy })).toBe(true)
    // ⚠️ An unrated model is Usual, so it IS auto-selectable — absence must never read as `special`,
    // or every hand-added endpoint would silently become unroutable.
    expect(ModelTaxonomy.autoSelectable({ taxonomy: undefined })).toBe(true)
  })

  test("`of` never materialises special from an absent rating", () => {
    expect(ModelTaxonomy.of({ taxonomy: undefined })).toBe("usual")
    expect(ModelTaxonomy.of({ taxonomy: "special" })).toBe("special")
  })
})
