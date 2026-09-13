import { describe, expect, test } from "bun:test"
import { PERSONALITY_FORMAT, parseOfficerPersonality } from "./agent-personality"

describe("officer personality JSON", () => {
  test("accepts the portable profile and ignores authority-shaped extras", () => {
    expect(
      parseOfficerPersonality(
        JSON.stringify({
          format: PERSONALITY_FORMAT,
          version: 1,
          profile: { name: "Iris", title: "Editor", personality: "Warm", job: "Polish prose", superior: "nova" },
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        }),
      ),
    ).toEqual({
      format: PERSONALITY_FORMAT,
      version: 1,
      profile: { name: "Iris", title: "Editor", personality: "Warm", job: "Polish prose" },
    })
  })

  test("rejects generic or malformed JSON", () => {
    expect(parseOfficerPersonality("{}")).toBeUndefined()
    expect(parseOfficerPersonality("not json")).toBeUndefined()
  })
})
