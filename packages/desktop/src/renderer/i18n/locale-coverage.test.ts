import { describe, expect, test } from "bun:test"
import { LOCALES, build } from "./index"
import { LOCALES as SHARED_LOCALES } from "@novaclaw/schema/locale"

// 🔴 EVERY LANGUAGE THE PICKER OFFERS MUST REACH THE DESKTOP SHELL.
//
// This module used to keep its own 16-entry locale union, its own `LOCALES` array and its own
// 16-branch `detectLocale`, all of them two short of the app's eighteen. A user who chose Turkish or
// Thai — both in the app's language picker — had `parseLocale` reject the stored value, fall back to
// a `detectLocale` with no branch for them either, and get the splash, dialogs and CLI alerts in
// English. Nothing failed; the shell simply ignored the language they picked.
//
// So the assertion is not "the two lists are equal" (they are one list now, and that cannot fail) —
// it is that every offered locale actually CHANGES the dictionary. That is the property the drift
// broke, and it is the one that survives the tables being merged.

describe("the desktop shell speaks every language the app offers", () => {
  test("the locale table is the shared one, not a copy", () => {
    expect(LOCALES).toBe(SHARED_LOCALES)
  })

  test("every non-English locale translates a substantial share of the shell", async () => {
    const en = (await build("en")) as Record<string, string>
    const keys = Object.keys(en)
    expect(keys.length, "the English dictionary is empty — this test is measuring nothing").toBeGreaterThan(500)

    const thin: string[] = []
    for (const locale of LOCALES) {
      if (locale === "en") continue
      const dict = (await build(locale)) as Record<string, string>
      const translated = keys.filter((key) => dict[key] !== en[key]).length
      if (translated < 100) thin.push(`${locale} (${translated} of ${keys.length})`)
    }
    expect(
      thin,
      "a locale the language picker offers renders the desktop shell in English. Either give it a " +
        "dictionary or take it out of the picker — silently ignoring the user's choice is neither.",
    ).toEqual([])
  })

  test("`build` is total — an unknown locale cannot silently take another language's dictionary", async () => {
    // The `if`-chain this replaced ended in an unlabelled `return` of the KOREAN dictionary, so a
    // locale nobody wrote an arm for got Korean rather than English. `OVERLAYS` is a
    // `Record<Exclude<Locale, "en">, …>`, so a missing arm is a compile error — but a runtime miss
    // must still not resolve to somebody else's language.
    await expect(build("nonexistent" as never)).rejects.toThrow()
  })
})
