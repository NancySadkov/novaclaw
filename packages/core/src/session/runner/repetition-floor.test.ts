import { describe, expect, it } from "bun:test"
import type { ModelV2 } from "../../model"
import { DEFAULT_REPETITION_PENALTY, withRepetitionFloor } from "./repetition-floor"

// Only `request.body` matters to the floor; a minimal cast keeps the test free of the full
// ModelV2.Info schema construction.
const model = (body: Record<string, unknown>): ModelV2.Info =>
  ({ request: { body, headers: {}, variant: "default" } }) as unknown as ModelV2.Info

describe("withRepetitionFloor", () => {
  it("defaults repetition_penalty to 1.05 when the model sets none", () => {
    expect(DEFAULT_REPETITION_PENALTY).toBe(1.05)
    const out = withRepetitionFloor(model({}))
    expect(out.request.body.repetition_penalty).toBe(1.05)
  })

  it("respects an explicit value — including 1.0 (off)", () => {
    expect(withRepetitionFloor(model({ repetition_penalty: 1.1 })).request.body.repetition_penalty).toBe(1.1)
    expect(withRepetitionFloor(model({ repetition_penalty: 1 })).request.body.repetition_penalty).toBe(1)
  })

  it("preserves other sampling fields and does not mutate the input", () => {
    const input = model({ temperature: 0.6, top_p: 0.95 })
    const out = withRepetitionFloor(input)
    expect(out.request.body.temperature).toBe(0.6)
    expect(out.request.body.top_p).toBe(0.95)
    expect(out.request.body.repetition_penalty).toBe(1.05)
    // The input is left untouched (immer copy-on-write).
    expect((input.request.body as Record<string, unknown>).repetition_penalty).toBeUndefined()
  })
})
