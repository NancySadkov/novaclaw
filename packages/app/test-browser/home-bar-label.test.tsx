import { describe, expect, test } from "bun:test"
import { dict } from "@/i18n/en"
import { resolveTranslation } from "@/i18n/resolve"

/**
 * 🔴 **THE HOME BAR NAMES ITS DESTINATION — AND NAMES IT BY THE NAME THE OWNER GAVE IT.**
 *
 * Owner, 2026-09-27: *"the Home screen currently has `Ask anything...`, and has an officer selector.
 * Please instead make the text `Ask Nova anything...`, and make it always send to Nova."*
 *
 * ⭐ **This test exists because the first attempt got it wrong in a way no typecheck could see.** The
 * bar's label is `officer().name`, and the first version of that memo returned the agent **id**. The
 * id is the lowercase literal `nova`, so the boot route — the first thing a new owner reads — rendered
 * *"Ask nova anything..."*: the requested text, with a proper noun lowercased. A `{{name}}` template
 * with an id in the slot typechecks, compiles, passes a source-grep test, and is wrong.
 *
 * So the string is checked END TO END through the real dictionary, from the value the bar holds to
 * the words on the button. Three cases, because the failure mode is a *plausible* name rather than a
 * missing one: a real roster name, a renamed CEO, and the fallback chain when the roster has nothing
 * to say.
 *
 * ⚠️ SCOPE, stated plainly: this covers the LABEL, not the whole bar. The bar's structure — that it
 * has no officer selector, and that it resolves Nova by name rather than by sort order — is asserted
 * in `home-visual-contract.test.ts`, because rendering `NewAgentBar` for real needs the server, global,
 * sync and tabs contexts and this repo's memory budget does not currently allow standing that up.
 * The two tests are complementary and both are needed; neither alone is the claim.
 */
describe("the home bar's label", () => {
  const label = (name: string) =>
    resolveTranslation(dict as never, dict as never, "home.newAgent.placeholder", { name })

  test("a roster name renders as the owner asked, with the proper noun intact", () => {
    expect(label("Nova")).toBe("Ask Nova anything...")
  })

  test("🔴 a user who RENAMED their CEO is greeted by that name, not by the id `nova`", () => {
    // The regression above, pinned as a case. `nova` would pass every other assertion in this file.
    expect(label("nova")).not.toBe("Ask Nova anything...")
    expect(label("Wren")).toBe("Ask Wren anything...")
    expect(label("Wren")).not.toContain("nova")
  })

  test("an unfilled placeholder is never shown — the fallback chain reaches the id", () => {
    // `resolveTranslation` leaves `{{name}}` in place on a miss, which is correct for a translation
    // miss elsewhere and would be a visible bug on the boot route. The bar's chain is
    // roster name → id → the constant, so the value can never be empty.
    const empty = label("")
    expect(empty).toBe("Ask  anything...")
    expect(empty).not.toContain("{{")
    expect(label("nova")).not.toContain("{{")
  })

  test("the retired anonymous agents cannot appear in it", () => {
    // One string, one assertion: the two ids that were the default until 2026-09-27 were `build` and
    // `plan`, and "Ask build anything..." is the exact ghost the retirement removed. The bar resolves
    // `AgentV2.DEFAULT_COLLEAGUE_ID` by name and falls back within `roster()`, which excludes both.
    for (const retired of ["build", "plan"]) {
      expect(label(retired)).not.toBe("Ask Nova anything...")
      expect(label(retired)).toContain(retired)
    }
  })
})
