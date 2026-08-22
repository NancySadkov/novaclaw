import { describe, expect, test, beforeEach } from "bun:test"
import { ModelHealth } from "./model-health"

// The rule behind the owner's *"if the agent's chosen model is unavailable / gives errors, we
// temporarily auto switch to the Default model"* — the "gives errors" half.
//
// ⚠️ Every test here asserts a case where the OBVIOUS implementation is wrong: one failure demoting a
// model, a failure never ageing out, a success on the substitute clearing the sick model's record.
// A test that only proves "two failures make it sick" would pass against three different broken
// versions of this module.

const spark = { providerID: "spark-holo", id: "holo3.1" }
const other = { providerID: "anthropic", id: "claude-opus-5" }

beforeEach(() => ModelHealth.reset())

describe("ModelHealth", () => {
  test("one failure is a BLIP, not a verdict", () => {
    ModelHealth.failed(spark, 1_000)
    expect(ModelHealth.sick(spark, 1_000)).toBe(false)
  })

  test("two failures inside the window is a sick endpoint", () => {
    ModelHealth.failed(spark, 1_000)
    ModelHealth.failed(spark, 2_000)
    expect(ModelHealth.sick(spark, 2_000)).toBe(true)
  })

  test("failures AGE OUT — two failures an hour apart is a model that works", () => {
    ModelHealth.failed(spark, 0)
    ModelHealth.failed(spark, 60 * 60_000)
    expect(ModelHealth.sick(spark, 60 * 60_000)).toBe(false)
  })

  test("a sick model recovers the moment one turn succeeds", () => {
    ModelHealth.failed(spark, 1_000)
    ModelHealth.failed(spark, 2_000)
    expect(ModelHealth.sick(spark, 2_000)).toBe(true)
    ModelHealth.succeeded(spark)
    expect(ModelHealth.sick(spark, 2_000)).toBe(false)
  })

  test("health is PER ENDPOINT — a dead local server does not demote the cloud", () => {
    ModelHealth.failed(spark, 1_000)
    ModelHealth.failed(spark, 2_000)
    expect(ModelHealth.sick(other, 2_000)).toBe(false)
  })

  test("the same model id on two providers is two endpoints", () => {
    const a = { providerID: "spark-holo", id: "shared" }
    const b = { providerID: "openrouter", id: "shared" }
    ModelHealth.failed(a, 1_000)
    ModelHealth.failed(a, 2_000)
    expect(ModelHealth.sick(a, 2_000)).toBe(true)
    expect(ModelHealth.sick(b, 2_000)).toBe(false)
  })

  // 🔴 THE FLAP. Once a model is sick the runner routes to the substitute — and the substitute then
  // succeeds, over and over. If the runner recorded that success against the SELECTED model (which is
  // still the sick one) rather than the model that actually answered, the sick record would clear,
  // the next turn would go back to the dead endpoint, fail, and the cycle would repeat forever at a
  // cost of one failed turn each time. This asserts the two records never touch.
  test("success on the substitute does not clear the sick model's record", () => {
    ModelHealth.failed(spark, 1_000)
    ModelHealth.failed(spark, 2_000)
    ModelHealth.succeeded(other)
    expect(ModelHealth.sick(spark, 3_000)).toBe(true)
  })

  test("the failure list is TRIMMED, not grown forever", () => {
    for (let n = 0; n < 50; n++) ModelHealth.failed(spark, n * 60_000)
    // Only the last window's worth survives — a process running for weeks holds a bounded list.
    expect(ModelHealth.failures(spark, 49 * 60_000)).toBeLessThanOrEqual(ModelHealth.WINDOW_MS / 60_000 + 1)
  })

  test("isSick is pure — the same inputs answer the same way with no store involved", () => {
    expect(ModelHealth.isSick([1_000, 2_000], 2_000)).toBe(true)
    expect(ModelHealth.isSick([1_000], 2_000)).toBe(false)
    expect(ModelHealth.isSick([], 2_000)).toBe(false)
  })
})
