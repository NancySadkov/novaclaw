import { afterEach, describe, expect, test } from "bun:test"
import { ModelHealth } from "@novaclaw/core/session/runner/model-health"
import { healthyAlternative } from "@novaclaw/core/session/runner/model"
import { isModelMissing } from "@novaclaw/llm"

/**
 * THE SELF-HEALING INVARIANT — a model the endpoint does not have must not be chosen again.
 *
 * Owner, 2026-09-02: *"ensure the agent's model gets invalidated on failure and replaced with an
 * available model, so `no model` failure becomes impossible when at least a single model is
 * available — that is a strict invariant."*
 *
 * What made it necessary, measured on a live instance: a chat pinned to `holo3.1` after the endpoint
 * moved to another model failed on every single turn. Three separate things had to be true for that:
 *
 *  1. the CATALOG still listed the model, so the availability fallback saw nothing wrong with it;
 *  2. the health fallback needs TWO failures inside ten minutes, and a permanent 404 was being
 *     counted as if it were a flaky one;
 *  3. health is process-lifetime, so restarting the app forgot the two failures and began again.
 *
 * ⚠️ THE SCOPE, which is the owner's second sentence: this applies to the model NOBODY CHOSE. When
 * the user explicitly picks a model, a dead one still surfaces as an error offering to switch —
 * silently running something else is answering a question nobody asked. That half is enforced in
 * `model.ts` by `options?.requested !== true` and asserted in `session-runner-model.test.ts`.
 */

const m = (id: string) => ({ providerID: "p", id })
const all = () => true
const same = (a: { id: string }, b: { id: string }) => a.id === b.id

afterEach(() => {
  ModelHealth.reset()
})

describe("an endpoint that says it does not have the model", () => {
  test("🔴 is recognised from the provider's own words", () => {
    expect(
      isModelMissing('Provider request failed with HTTP 404: {"message":"The model `holo3.1` does not exist."}'),
    ).toBe(true)
    expect(isModelMissing("model gpt-9 not found")).toBe(true)
    expect(isModelMissing("no such model")).toBe(true)
  })

  test("CONTROL — an ordinary fault is not read as a missing model", () => {
    // Without this the predicate could return true for everything and the whole mechanism would
    // retire healthy models on any blip.
    expect(isModelMissing("connect ECONNREFUSED 192.168.178.40:8010")).toBe(false)
    expect(isModelMissing("HTTP 400: temperature must be between 0 and 2")).toBe(false)
    // A missing FILE is not a missing model, even though it says "not found".
    expect(isModelMissing("HTTP 404: requested file was not found")).toBe(false)
  })

  test("🔴 counts IMMEDIATELY — one answer, no threshold, no window", () => {
    // The defect in one assertion. `failed` needs THRESHOLD (2) inside WINDOW_MS to demote; a 404
    // naming the model is not weak evidence and must not wait for a second identical failure.
    const at = 1_000
    ModelHealth.failed(m("gone"), at)
    expect(ModelHealth.sick(m("gone"), at)).toBe(false) // one ordinary failure is not enough — by design

    ModelHealth.retired(m("gone"))
    expect(ModelHealth.sick(m("gone"), at)).toBe(true)
    expect(ModelHealth.isRetired(m("gone"))).toBe(true)
  })

  test("does not age out of the window the way a flaky turn does", () => {
    ModelHealth.retired(m("gone"))
    // Long past WINDOW_MS. A retired model has not got better with time; only a working turn says so.
    expect(ModelHealth.sick(m("gone"), ModelHealth.WINDOW_MS * 10)).toBe(true)
  })

  test("a turn that WORKS on it un-retires it — the endpoint served, so the fact is over", () => {
    // Without this a model that came back after the operator restarted their server would stay
    // routed-around for the life of the process, with nothing on screen explaining why.
    ModelHealth.retired(m("gone"))
    ModelHealth.succeeded(m("gone"))
    expect(ModelHealth.isRetired(m("gone"))).toBe(false)
    expect(ModelHealth.sick(m("gone"), 1_000)).toBe(false)
  })

  test("retiring one model says nothing about another", () => {
    ModelHealth.retired(m("gone"))
    expect(ModelHealth.sick(m("other"), 1_000)).toBe(false)
  })
})

describe("the invariant: one available model is enough", () => {
  test("🔴 a retired model is replaced whenever anything else can serve", () => {
    const at = 1_000
    ModelHealth.retired(m("gone"))
    const chosen = healthyAlternative({
      selected: m("gone"),
      fallback: m("gone"), // the instance default is the dead one too — the nastier case
      available: [m("gone"), m("works")],
      supported: all,
      sick: (entry) => ModelHealth.sick(entry, at),
      same,
    })
    expect(chosen).toEqual(m("works"))
  })

  test("it never routes onto another model that is also gone", () => {
    const at = 1_000
    ModelHealth.retired(m("gone"))
    ModelHealth.retired(m("also-gone"))
    const chosen = healthyAlternative({
      selected: m("gone"),
      fallback: m("also-gone"),
      available: [m("gone"), m("also-gone"), m("works")],
      supported: all,
      sick: (entry) => ModelHealth.sick(entry, at),
      same,
    })
    expect(chosen).toEqual(m("works"))
  })

  test("CONTROL — with nothing else available it stays put and reports the real error", () => {
    // The invariant is conditioned on at least one model being available. With none, inventing a
    // destination would be worse than the honest failure: bouncing between two dead endpoints
    // reports neither.
    const at = 1_000
    ModelHealth.retired(m("gone"))
    expect(
      healthyAlternative({
        selected: m("gone"),
        fallback: m("gone"),
        available: [m("gone")],
        supported: all,
        sick: (entry) => ModelHealth.sick(entry, at),
        same,
      }),
    ).toBeUndefined()
  })

  test("CONTROL — an available model this session cannot USE is not a destination", () => {
    // "Available" is not "usable": a vision chat cannot heal onto a text-only model. Falling back
    // onto it would swap one refusal for another.
    const at = 1_000
    ModelHealth.retired(m("gone"))
    expect(
      healthyAlternative({
        selected: m("gone"),
        fallback: undefined,
        available: [m("gone"), m("text-only")],
        supported: (entry) => entry.id !== "text-only",
        sick: (entry) => ModelHealth.sick(entry, at),
        same,
      }),
    ).toBeUndefined()
  })
})
