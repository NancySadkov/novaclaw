// improve18: AFFECTIVE × STRICT — the jh-side driver of the SAME homeostat the session drain loop
// uses. These pin the contract that matters for Strict: repeated failures build anti-repetition
// pressure (the refrain/self-copy answer), progress calms it back down, and temperature is NEVER
// blown out (every jh call is tool-call JSON — affective's own toolsPresent contract).
import { describe, expect, test } from "bun:test"
import { JhAffective } from "@novaclaw/core/jh/affective"
import { Affective } from "@novaclaw/core/affective"

const base = { temperature: 0.6, topP: 0.95 }
/** Drive N identical failing steps — the rut shape (waves 15-17: 9-25 repeats of one signature). */
const rut = (n: number, detail = "ch2.md repeats passages from ch1.md nearly verbatim (27 shared)") => {
  let s = JhAffective.initial
  for (let i = 0; i < n; i++) s = JhAffective.step(s, { action: `write_file(root.3)`, result: detail, acted: true })
  return s
}

describe("JhAffective (improve18: affective × strict)", () => {
  test("a repeated failure builds frustration + boredom — the rut is FELT", () => {
    const calm = JhAffective.initial
    const stuck = rut(4)
    expect(calm.mood.frustration).toBe(0)
    expect(stuck.mood.frustration).toBeGreaterThan(0.5)
    expect(stuck.mood.boredom).toBeGreaterThan(0.3)
  })

  test("the rut raises ANTI-REPETITION pressure — the sampling answer to the refrain defect", () => {
    const calmS = JhAffective.sampling(JhAffective.initial, base)
    const stuckS = JhAffective.sampling(rut(4), base)
    expect(stuckS.frequencyPenalty).toBeGreaterThan(calmS.frequencyPenalty)
    expect(stuckS.presencePenalty).toBeGreaterThan(calmS.presencePenalty)
    expect(stuckS.frequencyPenalty).toBeGreaterThan(0.2)
  })

  test("temperature respects the DEFAULT tool ceiling (0.6) when the model declares none", () => {
    for (const n of [0, 1, 4, 12]) {
      const s = JhAffective.sampling(rut(n), base)
      expect(s.temperature).toBeLessThanOrEqual(0.6)
      expect(s.topP).toBeLessThanOrEqual(0.9)
    }
  })

  test("a model that declares a HIGHER tool ceiling is allowed to reach it (the Qwen3.6 measurement)", () => {
    // Measured for our build: step-JSON 6/6 at every temperature 0.3-1.3, while creative diversity
    // only exists at ≥1.0 (its own default). The 0.6 clamp is a general heuristic, false HERE — so
    // the ceiling is a model property. Frustration must still be able to push temperature UP toward it.
    const qwen = { ...base, temperature: 1.0, toolTempCeil: 1.0 }
    const calm = JhAffective.sampling(JhAffective.initial, qwen)
    expect(calm.temperature).toBeGreaterThan(0.6) // no longer pinned into the flat zone
    expect(calm.temperature).toBeLessThanOrEqual(1.0) // but never past what the model declares
    const stuck = JhAffective.sampling(rut(4), qwen)
    expect(stuck.temperature).toBeLessThanOrEqual(1.0)
  })

  test("progress CALMS the homeostat back down (frustration decays, penalties relax)", () => {
    const stuck = rut(4)
    let s = stuck
    for (let i = 0; i < 3; i++) s = JhAffective.step(s, { result: `progress:${i}`, acted: true })
    expect(s.mood.frustration).toBeLessThan(stuck.mood.frustration)
    expect(JhAffective.sampling(s, base).frequencyPenalty).toBeLessThan(JhAffective.sampling(stuck, base).frequencyPenalty)
  })

  test("a deep rut trips the one-shot intervention (the loop-breaker steer)", () => {
    expect(JhAffective.intervention(JhAffective.initial)).toBeUndefined()
    const steer = JhAffective.intervention(rut(6))
    expect(steer).toBeDefined()
    expect(steer).toContain("did not change the result")
  })

  test("fromLog folds jh's own events: action+failed verification = a rut; committed = progress", () => {
    const pending: { action?: string } = {}
    let s = JhAffective.initial
    for (let i = 0; i < 4; i++) {
      s = JhAffective.fromLog(s, { type: "action", step: "root.3", tool: "write_file" }, pending)
      s = JhAffective.fromLog(s, { type: "verification", step: "root.3", ok: false, detail: "same error again" }, pending)
    }
    const stuck = s.mood.frustration
    expect(stuck).toBeGreaterThan(0.4)
    s = JhAffective.fromLog(s, { type: "committed", step: "root.3" }, pending)
    expect(s.mood.frustration).toBeLessThan(stuck)
  })

  test("a model whose baseline penalty is HIGH is never modulated DOWN (the Qwen3.6 anti-repetition trap)", () => {
    // Our Spark serves Qwen3.6-35B-A3B with `--override-generation-config {"presence_penalty":1.1,…}`
    // (the MoE build's documented anti-repetition default). The old ABSOLUTE cap turned that into
    // clamp(1.1+boredom, 0, 0.5) = 0.5 — affective would have STRIPPED the model's repetition
    // protection while claiming to fight repetition, and the wave-18 A/B would have blamed the lever.
    const qwen = { temperature: 0.6, topP: 0.95, presencePenalty: 1.1, frequencyPenalty: 0 }
    const calm = JhAffective.sampling(JhAffective.initial, qwen)
    expect(calm.presencePenalty).toBe(1.1) // never below the model's own baseline
    const stuck = JhAffective.sampling(rut(4), qwen)
    expect(stuck.presencePenalty).toBeGreaterThan(1.1) // boredom RAISES it
    expect(stuck.presencePenalty).toBeLessThanOrEqual(1.6) // by at most our headroom
    expect(stuck.presencePenalty).toBeLessThanOrEqual(2) // and never past Qwen's documented ceiling
  })

  test("a zero baseline behaves exactly as before (the fix is a no-op for every other config)", () => {
    const zero = { temperature: 0.6, topP: 0.95 }
    expect(JhAffective.sampling(JhAffective.initial, zero).presencePenalty).toBe(0)
    const stuck = JhAffective.sampling(rut(4), zero)
    expect(stuck.presencePenalty).toBeGreaterThan(0)
    expect(stuck.presencePenalty).toBeLessThanOrEqual(0.5)
  })

  test("it is the SAME engine as the session drain loop (no look-alike homeostat)", () => {
    // Identical facts through both entry points must yield an identical mood.
    const viaJh = JhAffective.step(JhAffective.initial, { action: "a(1)", result: "error: boom", acted: true })
    const viaSession = Affective.appraiseObserved(Affective.calmMood, { action: "a(1)", toolResult: "error: boom", acted: true })
    expect(viaJh.mood).toEqual(viaSession)
  })
})
