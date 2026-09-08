import { describe, expect, test } from "bun:test"
import { generateConfigTemplate } from "../components/settings-v2/config-io"
import { JSONCParseError, parseJSONC } from "./jsonc"

describe("JSONC config import", () => {
  test("preserves every string byte through export and import", () => {
    const config = {
      agents: {
        nova: {
          system: 'Use // comments; retain /* secrets */; say "quoted"; keep C:\\\\models\\nova',
        },
      },
      providers: {
        local: {
          url: "https://x.test/path//segment?redirect=//internal",
        },
      },
    }

    expect(parseJSONC(generateConfigTemplate(config))).toEqual({
      $schema: "https://novaclaw.app/config.json",
      ...config,
    })
  })

  test("accepts line comments, block comments, and trailing commas", () => {
    const escaped = 'quote: " and slash: \\'
    const input = String.raw`{
      // a real line comment
      "system": "Use // inside the string",
      /* a real block comment */
      "instruction": "Never emit /* secrets */",
      "escaped": ${JSON.stringify(escaped)},
      "url": "https://x.test/path//later",
    }`

    expect(parseJSONC(input)).toEqual({
      system: "Use // inside the string",
      instruction: "Never emit /* secrets */",
      escaped,
      url: "https://x.test/path//later",
    })
  })

  test("throws explicit issues instead of returning a malformed partial object", () => {
    const input = `{
      "providers": { "valid": {} },
      "agents":
    }`

    try {
      parseJSONC(input)
      throw new Error("expected malformed JSONC to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(JSONCParseError)
      const parseError = error as JSONCParseError
      expect(parseError.issues.length).toBeGreaterThan(0)
      expect(parseError.issues[0]).toMatchObject({ code: "ValueExpected", line: 4, column: 5 })
      expect(parseError.message).toContain("ValueExpected at line 4, column 5")
    }
  })
})
