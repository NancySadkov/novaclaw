// F1a SLICE 5: unit coverage for the slash-command template expansion that
// SessionV2.command runs before submitting the expanded text as a prompt. The pure
// expander holds the substantive logic (positional args, last-soaks-the-rest,
// $ARGUMENTS, no-placeholder append, quote trimming) — the method wiring around it is
// thin glue (get command via the Location, then the same admit+wake as `prompt`).
import { describe, expect, test } from "bun:test"
import { expandCommandTemplate } from "@novaclaw/core/session"

describe("expandCommandTemplate (F1a SLICE 5)", () => {
  test("substitutes distinct positional args", () => {
    expect(expandCommandTemplate("Review $1 in $2", "foo bar")).toBe("Review foo in bar")
  })

  test("the highest-numbered placeholder soaks up all remaining args", () => {
    // $1 is the only (thus highest) placeholder → gets everything.
    expect(expandCommandTemplate("Fix $1", "a b c")).toBe("Fix a b c")
    // $2 is the highest → $1 takes one arg, $2 takes the rest.
    expect(expandCommandTemplate("Do $1 then $2", "a b c d")).toBe("Do a then b c d")
  })

  test("$ARGUMENTS is the whole raw string", () => {
    expect(expandCommandTemplate("Summarize: $ARGUMENTS", "the whole thing")).toBe("Summarize: the whole thing")
  })

  test("with no placeholders and non-empty args, the raw args are appended", () => {
    expect(expandCommandTemplate("Just do it", "extra context")).toBe("Just do it\n\nextra context")
  })

  test("no placeholders and empty args leaves the template untouched", () => {
    expect(expandCommandTemplate("No args needed", "")).toBe("No args needed")
  })

  test("quoted args are treated as one token with quotes trimmed", () => {
    expect(expandCommandTemplate("Greet $1", '"Ada Lovelace"')).toBe("Greet Ada Lovelace")
  })

  test("an out-of-range placeholder expands to empty", () => {
    expect(expandCommandTemplate("Missing $2 here", "only")).toBe("Missing  here")
  })
})
