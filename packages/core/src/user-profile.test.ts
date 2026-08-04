// B4 — user-profile system-prompt layer (pure).
import { describe, expect, test } from "bun:test"
import { resolve } from "./user-profile"

describe("UserProfile.resolve", () => {
  test("nothing configured -> undefined (no empty scaffolding in the prompt)", () => {
    expect(resolve(undefined)).toBeUndefined()
    expect(resolve({})).toBeUndefined()
    expect(resolve({ name: "  ", about: "" })).toBeUndefined()
  })

  test("name + about compose the block", () => {
    expect(resolve({ name: "Nancy", about: "systems programmer building a local-LLM harness" })).toBe(
      "About your user:\n- Name: Nancy\n- Background: systems programmer building a local-LLM harness",
    )
  })

  test("name only / about only", () => {
    expect(resolve({ name: "Nancy" })).toBe("About your user:\n- Name: Nancy")
    expect(resolve({ about: "likes Datalog" })).toBe("About your user:\n- Background: likes Datalog")
  })

  test("fallbackName covers the legacy `username` field; explicit name wins", () => {
    expect(resolve({}, { fallbackName: "nancy" })).toBe("About your user:\n- Name: nancy")
    expect(resolve({ name: "Nancy" }, { fallbackName: "ignored" })).toBe("About your user:\n- Name: Nancy")
  })

  test("whitespace trimmed", () => {
    expect(resolve({ name: " Nancy ", about: " x " })).toBe("About your user:\n- Name: Nancy\n- Background: x")
  })
})
