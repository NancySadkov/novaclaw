import { describe, expect, test } from "bun:test"
import { Model } from "../src/model"
import { Provider } from "../src/provider"

describe("Model defaults", () => {
  test("give an undisclosed model a 64K context and 16K response budget", () => {
    expect(Model.Info.empty(Provider.ID.make("provider"), Model.ID.make("model")).limit).toEqual({
      context: 65_536,
      output: 16_384,
    })
  })
})
