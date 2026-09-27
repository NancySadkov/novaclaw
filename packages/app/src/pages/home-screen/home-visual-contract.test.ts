import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const read = (relative: string) => fs.readFileSync(path.join(import.meta.dir, relative), "utf8")

describe("home-screen visual contracts", () => {
  test("a tile that declares a transparent glyph gets the shared launcher frame", () => {
    // Built-in glyphs and contributed transparent artwork share the same compact frame.
    const tile = read("app-tile.tsx")
    expect(tile).toContain("!!props.app.tileNeedsFrame")
  })

  test("Models uses the shared launcher frame with its own golden glyph", () => {
    // The tile must match the others: a transparent golden glyph that the renderer frames, like the
    // other framed tiles — not the gradient fallback it shipped with first (owner, 2026-09-16).
    const builtins = read("../../apps/builtins.tsx")
    expect(builtins).toMatch(/id: "models",[\s\S]*?tile: "\/assets\/skin\/glyphs\/models-generated\.png"/)
    expect(builtins).toMatch(/id: "models",[\s\S]*?tileNeedsFrame: true/)
    const png = fs.readFileSync(path.join(import.meta.dir, "../../../public/assets/skin/glyphs/models-generated.png"))
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  })

  test("every built-in tile URL resolves to a shipped asset", () => {
    const builtins = read("../../apps/builtins.tsx")
    const urls = [...builtins.matchAll(/tile: "(\/assets\/skin\/(?:tiles|glyphs)\/[^"]+)"/g)].map((match) => match[1]!)
    expect(urls.length).toBeGreaterThan(5)
    const missing = urls.filter(
      (url) => !fs.existsSync(path.join(import.meta.dir, "../../../public", url.replace(/^\//, ""))),
    )
    expect(missing, "a built-in tile points at artwork this build does not ship").toEqual([])
  })

  test("the officer picker on a chat uses the themed popup", () => {
    const control = read("../../components/composer/agent-control.tsx")

    expect(control).toContain('from "@novaclaw/ui/v2/select-v2"')
    expect(control).toContain("<SelectV2")
  })

  test("no app surface delegates an open picker to the operating system", () => {
    const sourceRoot = path.join(import.meta.dir, "../..")
    const nativeSelects = [...new Bun.Glob("**/*.tsx").scanSync({ cwd: sourceRoot })].filter((relative) =>
      fs.readFileSync(path.join(sourceRoot, relative), "utf8").includes("<select"),
    )

    expect(nativeSelects).toEqual([])
  })

  // Owner, 2026-09-27: "make the text `Ask Nova anything...`, and make it always send to Nova."
  test("the home bar has ONE destination and NAMES it", () => {
    const english = read("../../i18n/en.ts")
    const bar = read("./new-agent-bar.tsx")

    // The words name the officer, interpolated rather than hard-coded, so a user who RENAMED Nova
    // reads their own name for it. A literal "Nova" in the string would go stale the moment anyone
    // renames the CEO, and the bar is the app's boot route - the first thing a new owner reads.
    expect(english).toContain('"home.newAgent.placeholder": "Ask {{name}} anything..."')
    expect(english).not.toContain("opens ready to configure")
    expect(bar).toContain('language.t("home.newAgent.placeholder", { name: officer().name })')

    // ⚠️ The destination is asked FOR BY NAME, not inherited from a sort order. It already landed on
    // Nova under the old code, but only because `roster()` sorts the governing agent first - so the
    // owner's rule was satisfied by a coincidence of ordering that nothing would have flagged if it
    // changed. This is the assertion that would catch that.
    expect(bar).toContain("agentOptions().find((option) => option.id === AgentV2.DEFAULT_COLLEAGUE_ID)")
  })

  test("the home bar offers NO officer selector — one front door, not a choice", () => {
    const bar = read("./new-agent-bar.tsx")

    // A picker on a bar whose only action is to open Nova's chat made the common case a decision and
    // hid the fact that there was a default at all. Its absence is the change; asserting the ABSENCE
    // is what stops the next person adding it back as a convenience.
    //
    // ⚠️ Each assertion targets a DECLARATION, not a bare identifier. `chosenAgent` appears once in
    // this file still — inside the doc comment that explains what the bar used to do — and a
    // substring match on the bare name would fail on its own explanation, which is the fastest way to
    // teach everyone that a test like that gets deleted instead of fixed.
    expect(bar).not.toContain("ComposerAgentControl")
    expect(bar).not.toContain("= createSignal<string | undefined>()")
    expect(bar).not.toContain("setChosenAgent(")
  })
})
