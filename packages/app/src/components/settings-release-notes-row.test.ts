import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// The release-notes toggle exists in TWO Settings panels — the v1 `settings-general.tsx` and the v2
// `settings-v2/general.tsx` — because the v1→v2 component fork is still live (todo.md ruling 13). The
// release-notes status shipped 2026-07-28 has to appear under BOTH toggles, and the roadmap item that
// asked for it said, in as many words, "both panels must stay in sync".
//
// Two panels hand-copying one sentence is a drift generator: someone improves the wording in the panel
// they happen to have open, the other keeps the old text, both compile green, and the product now says
// two different things about one subsystem — which is the "a fault is never described falsely" half of
// ruling 2 failing quietly. So the sentence is not copied. Both panels render ONE component
// (`ReleaseNotesStatusLine`, exported from context/highlights.tsx) whose text comes from ONE pure
// projector over ONE set of i18n keys. Drift is unrepresentable for the wording itself.
//
// What is NOT unrepresentable, and is what these rules cover: a panel dropping the component, a panel
// growing its own copy of the sentence, or a second implementation appearing under the same name. Each
// rule is negative-controlled against the code that actually shipped before the change — a rule that
// cannot fail is not a rule.

const SRC = path.resolve(import.meta.dir, "..")

/** The two Settings panels that carry the release-notes toggle. Neither may be dropped from this list. */
const PANELS = ["components/settings-general.tsx", "components/settings-v2/general.tsx"] as const

/** The one file allowed to define the shared line. */
const OWNER = "context/highlights.tsx"

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8")
}

function sourceFiles(): string[] {
  return fs
    .readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
    .filter((rel) => fs.statSync(path.join(SRC, rel)).isFile())
}

/** The shape the panels had before the status landed: the toggle, and nothing that says how it went. */
const SHIPPED_WITHOUT_STATUS = `
        <SettingsRowV2
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch checked={settings.general.releaseNotes()} />
          </div>
        </SettingsRowV2>`

/** The obvious wrong fix: one panel resolves the status text itself. */
const PANEL_WITH_ITS_OWN_COPY = `
          description={\`\${language.t("settings.general.row.releaseNotes.description")} — \${language.t(
            "settings.general.row.releaseNotes.status.none",
          )}\`}`

type Rule = { name: string; violated: (source: string) => boolean; control: string }

const RULES: Rule[] = [
  {
    name: "the panel renders the shared status line",
    violated: (source) => !source.includes("<ReleaseNotesStatusLine />"),
    control: SHIPPED_WITHOUT_STATUS,
  },
  {
    name: "the panel imports it rather than defining its own",
    violated: (source) => !/import \{[^}]*ReleaseNotesStatusLine[^}]*\} from "@\/context\/highlights"/.test(source),
    control: SHIPPED_WITHOUT_STATUS,
  },
  {
    name: "the panel does not word the status itself",
    violated: (source) => source.includes("releaseNotes.status."),
    control: PANEL_WITH_ITS_OWN_COPY,
  },
]

describe("both Settings panels render one release-notes status", () => {
  for (const panel of PANELS) {
    const source = read(panel)

    for (const rule of RULES) {
      test(`${panel}: ${rule.name}`, () => {
        expect(rule.violated(source), `${panel} violates: ${rule.name}`).toBe(false)
      })
    }

    test(`${panel}: still carries the release-notes toggle the status belongs to`, () => {
      // If the toggle moves, the status must move with it — this fails rather than leaving a status
      // line stranded in a panel that no longer offers the setting.
      expect(source).toContain(`data-action="settings-release-notes"`)
    })
  }

  for (const rule of RULES) {
    test(`negative control — "${rule.name}" bites`, () => {
      expect(rule.violated(rule.control), "this rule would not have caught the code that shipped").toBe(true)
    })
  }

  test("exactly one file defines the shared line", () => {
    const definers = sourceFiles().filter((rel) => /export function ReleaseNotesStatusLine\b/.test(read(rel)))
    expect(definers).toEqual([OWNER])
  })
})
