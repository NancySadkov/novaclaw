import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { dict as en } from "./en"

/**
 * A SETTINGS ROW IS SCANNED, NOT READ.
 *
 * Owner, 2026-08-24: the descriptions had grown into paragraphs — three of them ran past 200
 * characters — so a settings screen read as an essay and the one line you actually wanted was
 * buried. `SettingsRowV2` has carried a `hint` prop since 2026-08-13 for exactly this: the row stays
 * scannable and the explanation pops on hover or focus.
 *
 * ⚠️ This is a RATCHET, not a style opinion. It pins the descriptions that were shortened so the
 * long form cannot quietly come back, and it checks the two failure modes that make the split wrong
 * rather than merely long: a hint that resolves to a raw key, and detail deleted instead of moved.
 */

const t = en as Record<string, string>
const SETTINGS_SRC = path.join(import.meta.dir, "..", "components", "settings-v2")
const COMPONENTS_SRC = path.join(import.meta.dir, "..", "components")

/** Every key whose long copy was split into `description` + `hint`. */
const SPLIT = [
  "settings.strict.row.reasoningTokens",
  "settings.strict.row.enabled",
  "settings.strict.row.executionTokens",
  "settings.storage.instanceHome",
  "settings.computer.display",
  "settings.computer.windows",
  "settings.general.row.health",
  "settings.general.row.defaultPermissionMode",
  "settings.memory.enabled",
  "settings.recovery.row.resetUi",
  "settings.recovery.row.snapshots",
  "settings.confinement.probe",
  "settings.profile.enabled",
  "settings.storage.logs.level",
  "settings.systemPrompt.persona.enabled",
  "settings.tunes.context.enabled",
]

/** The model-config dialog uses `.desc` rather than `.description`. */
const SPLIT_DESC = [
  "settings.models.config.apiPath",
  "settings.models.config.apiKey",
  "settings.models.config.providerName",
  "settings.models.config.prePrompt",
  "settings.models.config.tool_call",
  "settings.models.config.thinkingBudget",
]

const pairs = [
  ...SPLIT.map((base) => ({ base, desc: `${base}.description`, hint: `${base}.description.more` })),
  ...SPLIT_DESC.map((base) => ({ base, desc: `${base}.desc`, hint: `${base}.desc.more` })),
]

describe("settings row copy stays scannable", () => {
  test("🔴 every split row's description is one short line", () => {
    const long = pairs.filter((p) => (t[p.desc] ?? "").length > 90).map((p) => `${p.desc} = ${t[p.desc]?.length}`)
    expect(long).toEqual([])
  })

  test("…and each one still has its hint", () => {
    const absent = pairs.filter((p) => typeof t[p.hint] !== "string").map((p) => p.hint)
    expect(absent).toEqual([])
  })

  test("🔴 the detail was MOVED, not deleted", () => {
    // The failure that would make this change a regression rather than a tidy-up: shortening the
    // description by throwing the explanation away. A hint shorter than its own description means
    // whatever the row stopped saying is now said nowhere.
    const thin = pairs
      .filter((p) => (t[p.hint] ?? "").length < 40)
      .map((p) => `${p.hint} is only ${(t[p.hint] ?? "").length} chars`)
    expect(thin).toEqual([])
  })

  test("🔴 nothing on a settings screen renders as a RAW KEY", () => {
    // A settings row whose title key is a typo has no copy at all — the live bug that key-typing was
    // introduced to catch, and the one this very change hit three times: `label` keys guessed as
    // `.title` on rows whose title key is `.name`.
    //
    // ⚠️ This comment used to say `language.t` returns the KEY when it is missing, and it never did.
    // `@solid-primitives/i18n@2.2.1` returns the looked-up value, i.e. `undefined`; `i18n/resolve.ts`
    // now falls back to English and then to `""`. So the miss reaches a user as a blank label, which
    // is why this test looks the key up in `en` rather than rendering and eyeballing the result.
    const files = fs
      .readdirSync(SETTINGS_SRC, { recursive: true, encoding: "utf8" })
      .filter((f) => typeof f === "string" && f.endsWith(".tsx"))
    const missing: string[] = []
    let sites = 0
    for (const f of files) {
      const src = fs.readFileSync(path.join(SETTINGS_SRC, f), "utf8")
      for (const m of src.matchAll(/language\.t\("(settings\.[^"{}]+|policies\.[^"{}]+)"\)/g)) {
        sites += 1
        if (typeof t[m[1]!] !== "string") missing.push(`${f}: ${m[1]}`)
      }
    }
    // Guards the guard: if the regex stops matching, this test would pass by finding nothing.
    expect(sites).toBeGreaterThan(200)
    expect(missing).toEqual([])
  })

  test("🔴 every `.more` string is reachable through the explain affordance", () => {
    // The half that makes the split safe rather than merely short. A `.more` key nothing renders is
    // detail deleted with extra steps — and `SettingsExplainV2` is the affordance that reaches it on
    // focus and touch, not only under a mouse.
    const files = fs
      .readdirSync(COMPONENTS_SRC, { recursive: true, encoding: "utf8" })
      .filter((f) => typeof f === "string" && f.endsWith(".tsx"))
    const rendered = new Set<string>()
    for (const f of files)
      for (const m of fs.readFileSync(path.join(COMPONENTS_SRC, f), "utf8").matchAll(/language\.t\("([^"{}]+\.more)"\)/g))
        rendered.add(m[1]!)
    const englishMore = Object.keys(t).filter((key) => key.endsWith(".more"))
    expect(englishMore.length).toBeGreaterThan(30)
    const unreachable = englishMore.filter((key) => !rendered.has(key))
    expect(unreachable).toEqual([])
  })
})
