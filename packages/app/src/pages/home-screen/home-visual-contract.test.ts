import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const read = (relative: string) => fs.readFileSync(path.join(import.meta.dir, relative), "utf8")

describe("home-screen visual contracts", () => {
  test("Skills declares that its transparent glyph needs the shared launcher frame", () => {
    const builtins = read("../../apps/builtins.tsx")
    const tile = read("app-tile.tsx")

    expect(builtins).toMatch(/id: "skills",[\s\S]*?tileNeedsFrame: true/)
    expect(tile).toContain("!!props.app.tileNeedsFrame")
  })

  test("the home agent picker uses the themed popup", () => {
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

  test('the home prompt says only "Ask anything..."', () => {
    const english = read("../../i18n/en.ts")

    expect(english).toContain('"home.newAgent.placeholder": "Ask anything..."')
    expect(english).not.toContain("opens ready to configure")
  })
})
