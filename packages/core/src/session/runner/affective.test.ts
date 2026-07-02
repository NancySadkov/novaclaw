import { describe, expect, test } from "bun:test"
import {
  FRUST_INTERVENE,
  URGENCY_INTERVENE,
  appraise,
  calmMood,
  intervention,
  toSampling,
  type Mood,
} from "./affective"
import type { SessionMessage } from "../message"

const assistant = (content: unknown[]) =>
  ({ type: "assistant", id: "msg_a", content, time: { created: 0 } }) as unknown as SessionMessage.Message

const tool = (name: string, input: unknown, output: string) => ({
  type: "tool",
  id: "call_1",
  name,
  state: { status: "completed", input, output, time: { start: 0, end: 1 } },
})

const text = (value: string) => ({ type: "text", id: "text-0", text: value })

describe("appraise (homeostasis + bumps, afpro parity)", () => {
  test("an error in the tool result bumps frustration", () => {
    const mood = appraise(calmMood, [assistant([tool("bash", "make", "error: build failed")])])
    expect(mood.frustration).toBeGreaterThanOrEqual(0.4)
  })
  test("the SAME tool result twice = no progress -> frustration + boredom", () => {
    const first = appraise(calmMood, [assistant([tool("bash", "ls", "same-output")])])
    const second = appraise(first, [assistant([tool("bash", "ls", "same-output")])])
    expect(second.frustration).toBeGreaterThan(first.frustration * 0.55)
    expect(second.boredom).toBeGreaterThan(0.25)
  })
  test("a genuinely NEW result = progress: satisfaction up, urgency reset", () => {
    const first = appraise(calmMood, [assistant([tool("bash", "ls", "old-output")])])
    const second = appraise(first, [assistant([tool("bash", "ls", "new-output")])])
    expect(second.satisfaction).toBeGreaterThanOrEqual(0.4)
    // progress resets the clock, then the end-of-step tick adds one increment
    expect(second.urgency).toBeCloseTo(0.15, 5)
  })
  test("talking without acting builds urgency; acting eases it", () => {
    let mood: Mood = calmMood
    for (let i = 0; i < 4; i++) mood = appraise(mood, [assistant([text("thinking about it…")])])
    expect(mood.urgency).toBeGreaterThan(0.5)
    const acted = appraise(mood, [assistant([tool("bash", "ls", "did it")])])
    expect(acted.urgency).toBeLessThan(mood.urgency + 0.15)
  })
  test("verbatim repeated assistant text bumps boredom (type-2 loop)", () => {
    const first = appraise(calmMood, [assistant([text("I will now read the file.")])])
    const second = appraise(first, [assistant([text("I will now read the file.")])])
    expect(second.boredom).toBeGreaterThanOrEqual(0.4)
  })
  test("moods decay toward calm without new events", () => {
    const agitated: Mood = { ...calmMood, frustration: 1, boredom: 1, satisfaction: 1 }
    const later = appraise(agitated, [])
    expect(later.frustration).toBeCloseTo(0.55, 5)
    expect(later.boredom).toBeCloseTo(0.55, 5)
  })
})

describe("toSampling (modulate AROUND the baseline, clamped)", () => {
  test("calm mood stays near the baseline", () => {
    const out = toSampling(calmMood, { temperature: 0.7, topP: 0.8 }, { toolsPresent: false, extended: false })
    expect(out.temperature).toBeGreaterThan(0.6)
    expect(out.temperature).toBeLessThan(0.85)
    expect(out.topK).toBeUndefined()
  })
  test("frustration pushes exploration up — but the tool-turn ceiling wins", () => {
    const frustrated: Mood = { ...calmMood, frustration: 1 }
    const free = toSampling(frustrated, { temperature: 0.7 }, { toolsPresent: false, extended: false })
    const toolTurn = toSampling(frustrated, { temperature: 0.7 }, { toolsPresent: true, extended: false })
    expect(free.temperature).toBeGreaterThan(0.9)
    expect(toolTurn.temperature).toBeLessThanOrEqual(0.6)
    expect(toolTurn.topP).toBeLessThanOrEqual(0.9)
  })
  test("temperature is hard-clamped at both ends", () => {
    const manic: Mood = { ...calmMood, frustration: 1, boredom: 1 }
    const zen: Mood = { ...calmMood, satisfaction: 1, urgency: 1 }
    expect(toSampling(manic, { temperature: 5 }, { toolsPresent: false, extended: false }).temperature).toBeLessThanOrEqual(1.15)
    expect(toSampling(zen, { temperature: 0 }, { toolsPresent: false, extended: false }).temperature).toBeGreaterThanOrEqual(0.2)
  })
  test("extended adds a bounded top_k", () => {
    const out = toSampling({ ...calmMood, frustration: 1 }, { topK: 20 }, { toolsPresent: false, extended: true })
    expect(out.topK).toBeGreaterThan(20)
    expect(out.topK).toBeLessThanOrEqual(120)
  })
})

describe("intervention", () => {
  test("high frustration triggers the change-course nudge", () =>
    expect(intervention({ ...calmMood, frustration: FRUST_INTERVENE })).toContain("different approach"))
  test("high urgency triggers the act-now nudge", () =>
    expect(intervention({ ...calmMood, urgency: URGENCY_INTERVENE })).toContain("ONE"))
  test("calm mood does not intervene", () => expect(intervention(calmMood)).toBeUndefined())
})
