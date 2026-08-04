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
// ⚠️ 2026-07-28 — THIS FILE WAS ITSELF THE DEFECT CLASS IT WAS WRITTEN AGAINST, and the bug it missed
// had already shipped. The rules below assert that both panel FILES contain the shared component. They
// say nothing about the CONDITIONS the panels render it under, and the two panels did not agree: the v2
// panel rendered `<UpdatesSection />` inside `<Show when={desktop()}>` while the v1 panel rendered it
// ungated. On web the v1 panel therefore showed the row and the v2 panel — the default one — showed
// nothing at all, and every rule here stayed green. A shared component makes it impossible for two
// panels to SAY different things; it does nothing to stop one of them from NOT SAYING IT AT ALL.
// Ruling 1 names exactly this: an invariant whose violation compiles green does not exist.
//
// So the second half of this file resolves, structurally, the stack of `<Show when={…}>` conditions
// that gates each row — THROUGH the local section component, because that is where the gate actually
// sat. A scan that only asked "is this JSX lexically inside a Show?" answers "no" for both panels and
// reproduces the original blind spot; there is a negative control below that pins precisely that.

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

  test("exactly the listed panels render the shared line", () => {
    // `PANELS` has to stay honest or every rule below it silently narrows: the gate comparison only
    // compares the panels it is told about. A third surface rendering the row — settings-v2/about.tsx
    // was a live candidate for it — would otherwise be unconstrained. Adding one here is not a
    // prohibition, it is a requirement to declare it so the gate agreement covers it too.
    const renderers = sourceFiles().filter((rel) => read(rel).includes("<ReleaseNotesStatusLine />"))
    expect(renderers.sort()).toEqual([...PANELS].sort())
  })
})

// ── The gate resolver ─────────────────────────────────────────────────────────────────────────────
//
// Both panels build their Settings tab out of local section components (`const UpdatesSection = () =>
// (…)`) that are DEFINED at the top of the panel component and RENDERED further down. The platform
// gate is applied at the render site, so the gate on a row is never lexically adjacent to the row.
// Resolving it means hopping: collect the `<Show>`s around the row, find the section component that
// encloses it, find where that section is rendered, collect the `<Show>`s there, repeat.
//
// Rejected alternatives, and why:
//   • Render both panels in happy-dom under a stubbed `desktop()` and diff the DOM. Strictly stronger —
//     it would see gates this resolver cannot express (`&&`, ternaries, a gate inside `SettingsRowV2`).
//     It needs the whole provider tree (settings, platform, language, expertise, permission, dialog,
//     server-sync, server-sdk, an SDK client for `pty.shells()`) stood up twice against two different
//     component libraries. That fixture is larger than both panels and fails for reasons unrelated to
//     the invariant; it is the right shape once a panel-level render harness exists, and there is none.
//   • Assert a literal string like `"<Show when={desktop()}>\n          <UpdatesSection />"`. Passes and
//     fails on whitespace, and says nothing about the OTHER panel — the property is agreement.
//   • Grep for `<Show when={desktop()}>` near the row. This is the check that already existed in spirit
//     and it is exactly what missed the bug: at the row, there is no Show to find.
//
// The resolver is deliberately narrow and LOUD: if it cannot resolve a hop (no enclosing component, a
// section rendered in two places, an unbalanced tag) it throws rather than returning an empty path. A
// guard that answers "no gates" when it means "I could not tell" is the bug this file already shipped
// once.

/**
 * Replace every comment and string/template literal with spaces of the same length, so the scans below
 * cannot trip on `<Show` inside a comment or a `{` inside a class name. Length is preserved on purpose:
 * indices into the blanked text are valid indices into the raw text.
 */
export function blankNonCode(source: string): string {
  const out = source.split("")
  const n = source.length
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " "
  }

  let i = 0
  while (i < n) {
    const c = source[i]
    const d = source[i + 1]

    if (c === "/" && d === "/") {
      let j = i
      while (j < n && source[j] !== "\n") j++
      blank(i, j)
      i = j
      continue
    }

    if (c === "/" && d === "*") {
      let j = i + 2
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++
      blank(i, Math.min(j + 2, n))
      i = j + 2
      continue
    }

    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1
      while (j < n) {
        if (source[j] === "\\") {
          j += 2
          continue
        }
        if (source[j] === c) break
        j++
      }
      blank(i, Math.min(j + 1, n))
      i = j + 1
      continue
    }

    i++
  }

  return out.join("")
}

/** Index of the `)`/`}` that closes the delimiter at `openIndex`. Throws rather than guessing. */
function matchDelimiter(code: string, openIndex: number): number {
  const open = code[openIndex]
  const close = open === "(" ? ")" : "}"
  if (open !== "(" && open !== "{") throw new Error(`offset ${openIndex} is not an opening delimiter`)

  let depth = 0
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === open) depth++
    else if (code[i] === close && --depth === 0) return i
  }
  throw new Error(`unbalanced ${open} at offset ${openIndex}`)
}

type ShowRegion = { condition: string; start: number; end: number }

/** Every `<Show when={…}>…</Show>` body, with the raw text of its condition. */
function showRegions(raw: string, code: string): ShowRegion[] {
  const regions: ShowRegion[] = []
  const open: { condition: string; bodyStart: number }[] = []
  const tag = /<(\/?)Show(?=[\s>/])/g

  let m: RegExpExecArray | null
  while ((m = tag.exec(code))) {
    if (m[1] === "/") {
      const start = open.pop()
      if (!start) throw new Error(`</Show> with no opener at offset ${m.index}`)
      regions.push({ condition: start.condition, start: start.bodyStart, end: m.index })
      continue
    }

    let condition = ""
    let selfClosing = false
    let i = m.index
    for (; i < code.length; i++) {
      if (code[i] === "{") {
        const close = matchDelimiter(code, i)
        if (/\bwhen=$/.test(code.slice(m.index, i))) condition = raw.slice(i + 1, close).trim()
        i = close
        continue
      }
      if (code[i] === ">") {
        selfClosing = code[i - 1] === "/"
        break
      }
    }
    if (i >= code.length) throw new Error(`unterminated <Show> tag at offset ${m.index}`)
    if (selfClosing) continue
    open.push({ condition, bodyStart: i + 1 })
  }

  if (open.length) throw new Error(`${open.length} unclosed <Show>`)
  return regions
}

type LocalComponent = { name: string; bodyStart: number; bodyEnd: number }

/** `const Name = () => (…)` / `= (props) => {…}` — the shape both panels use for their sections. */
function localComponents(code: string): LocalComponent[] {
  const found: LocalComponent[] = []
  const decl = /\bconst\s+([A-Z][\w$]*)\s*(?::[^=]*?)?=\s*(?:\(\s*(?:props)?\s*\)|\w+)\s*=>\s*[({]/g

  let m: RegExpExecArray | null
  while ((m = decl.exec(code))) {
    const bodyStart = m.index + m[0].length - 1
    found.push({ name: m[1], bodyStart, bodyEnd: matchDelimiter(code, bodyStart) })
  }
  return found
}

/**
 * The `<Show>` conditions that gate the code at `targetIndex`, outermost first, resolved across section
 * components. `[]` means "reached unconditionally"; anything the resolver cannot follow throws.
 */
export function gatePath(raw: string, targetIndex: number): string[] {
  const code = blankNonCode(raw)
  const regions = showRegions(raw, code)
  const components = localComponents(code)
  const gates: string[] = []

  let index = targetIndex
  for (let hop = 0; hop <= components.length; hop++) {
    gates.unshift(
      ...regions
        .filter((region) => region.start <= index && index < region.end)
        .sort((a, b) => a.start - b.start)
        .map((region) => region.condition),
    )

    const owner = components
      .filter((component) => component.bodyStart <= index && index < component.bodyEnd)
      .sort((a, b) => b.bodyStart - a.bodyStart)[0]
    if (!owner) return gates

    const sites: number[] = []
    const use = new RegExp(`<${owner.name}(?=[\\s>/])`, "g")
    let u: RegExpExecArray | null
    while ((u = use.exec(code))) {
      if (u.index < owner.bodyStart || u.index >= owner.bodyEnd) sites.push(u.index)
    }

    // The panel's own exported component is rendered by its importers, not here — that is the top.
    if (sites.length === 0) return gates
    if (sites.length > 1) throw new Error(`<${owner.name}> is rendered in ${sites.length} places — gate is ambiguous`)
    index = sites[0]
  }

  throw new Error("gate resolution did not terminate")
}

/** Index of the one and only occurrence of `needle`. Two of them means the gate question is ambiguous. */
export function soleIndex(source: string, needle: string): number {
  const first = source.indexOf(needle)
  if (first === -1) throw new Error(`not found: ${needle}`)
  if (source.indexOf(needle, first + 1) !== -1) throw new Error(`found more than once: ${needle}`)
  return first
}

/** The shared status line, and the update-check row that shares the Updates section with it. */
const ROW = {
  releaseNotes: "<ReleaseNotesStatusLine />",
  updateCheck: `language.t("settings.updates.row.check.title")`,
} as const

// ── The fixtures the gate rules are negative-controlled against ───────────────────────────────────
//
// `GATED_SECTION` is the shape `settings-v2/general.tsx` actually shipped with, reduced to the parts
// that matter: the section is defined with no gate on it, and gated where it is rendered. `OPEN_SECTION`
// is the v1 shape. Both are run through the same `gatePath` the real panels are.

const GATED_SECTION = `
export const Panel: Component = () => {
  const desktop = createMemo(() => platform.platform === "desktop")

  const UpdatesSection = () => (
    <SettingsListV2>
      <SettingsRowV2 description={<ReleaseNotesStatusLine />}>
        <div data-action="settings-release-notes" />
      </SettingsRowV2>
      <SettingsRowV2 title={language.t("settings.updates.row.check.title")} />
    </SettingsListV2>
  )

  return (
    <div>
      <Show when={desktop()}>
        <UpdatesSection />
      </Show>
    </div>
  )
}
`

/** A fixture derived by a substitution that silently did not fire is a fake control, so this checks. */
function substitute(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`fixture substitution found nothing to replace:\n${from}`)
  return source.replace(from, to)
}

const SECTION_GATE = `      <Show when={desktop()}>
        <UpdatesSection />
      </Show>`

const CHECK_ROW = `      <SettingsRowV2 title={language.t("settings.updates.row.check.title")} />`

const OPEN_SECTION = substitute(GATED_SECTION, SECTION_GATE, `      <UpdatesSection />`)

const SPLIT_SECTION = substitute(
  OPEN_SECTION,
  CHECK_ROW,
  `      <Show when={desktop()}>
  ${CHECK_ROW}
      </Show>`,
)

const RENDERED_TWICE = substitute(
  GATED_SECTION,
  "        <UpdatesSection />",
  "        <UpdatesSection />\n        <UpdatesSection />",
)

describe("both Settings panels gate the release-notes row identically", () => {
  const paths = PANELS.map((panel) => {
    const source = read(panel)
    return {
      panel,
      releaseNotes: gatePath(source, soleIndex(source, ROW.releaseNotes)),
      updateCheck: gatePath(source, soleIndex(source, ROW.updateCheck)),
    }
  })

  test("every panel agrees on what gates the release-notes row", () => {
    // The drift invariant, stated symmetrically: whatever we decide, every panel decides it together.
    // This is the rule that was missing when the v2 panel hid the row on web and this file stayed green.
    // Stated over the whole set rather than over a pair, so it keeps meaning something when a third
    // panel joins `PANELS` — which the renderer census above forces to happen.
    const distinct = new Set(paths.map((entry) => JSON.stringify(entry.releaseNotes)))
    const report = paths.map((entry) => `${entry.panel} → ${JSON.stringify(entry.releaseNotes)}`).join("; ")
    expect(distinct.size, `panels disagree on the release-notes gate: ${report}`).toBe(1)
  })

  for (const { panel, releaseNotes } of paths) {
    test(`${panel}: the release-notes row is reachable on every platform`, () => {
      // Decided 2026-07-28. Release notes are not an update mechanism — they are the product telling a
      // user what changed — and the subsystem behind the toggle RUNS on web: `HighlightsProvider` is
      // mounted for every entry point and fetches novaclaw.app/changelog.json on a version change, on
      // by default. A gate here leaves a web user with a live outbound request they cannot switch off
      // and no answer to "did the release notes work?", which is the silence ruling 2 forbids and the
      // obscurantism AGENTS.md forbids. Any gate at all hides the row from somebody; the row exists
      // precisely so nobody gets silence. Only the update-CHECK row beside it is desktop-only.
      expect(releaseNotes, `the release-notes row is gated on ${JSON.stringify(releaseNotes)}`).toEqual([])
    })

    test(`${panel}: the update-check row is desktop-only`, () => {
      // The other half of the split. `platform.updater` exists only in the Electron renderer, so on web
      // this button is permanently disabled with nothing to say why — a dead control. A web instance
      // updates when the instance serving it updates; there is nothing here to press.
      expect(paths.find((p) => p.panel === panel)!.updateCheck).toEqual(["desktop()"])
    })
  }

  test("negative control — the resolver follows the gate through the section component", () => {
    // THE control. In `GATED_SECTION` the status line is not lexically inside any `<Show>`; the gate is
    // two hops away, on the render site of the section that contains it. A scan that asked "is this row
    // inside a Show?" answers "no" — which is the answer the previous guard effectively gave, and why
    // the bug shipped. The resolver must answer "desktop()".
    const target = soleIndex(GATED_SECTION, ROW.releaseNotes)
    const lexicallyInsideAShow = /<Show\b[^>]*>[\s\S]*<ReleaseNotesStatusLine \/>/.test(
      GATED_SECTION.slice(0, GATED_SECTION.indexOf("</Show>")),
    )
    expect(lexicallyInsideAShow, "the fixture must reproduce the blind spot, not dodge it").toBe(false)
    expect(gatePath(GATED_SECTION, target)).toEqual(["desktop()"])
  })

  test("negative control — the agreement rule bites on the divergence that shipped", () => {
    const gated = gatePath(GATED_SECTION, soleIndex(GATED_SECTION, ROW.releaseNotes))
    const open = gatePath(OPEN_SECTION, soleIndex(OPEN_SECTION, ROW.releaseNotes))
    expect(gated).toEqual(["desktop()"])
    expect(open).toEqual([])
    expect(gated, "one panel gated and the other not must not compare equal").not.toEqual(open)
  })

  test("negative control — the split is a real distinction, not two rules that always agree", () => {
    // If the update-check rule could be satisfied by the same shape that satisfies the release-notes
    // rule, the "split" would be a description rather than a constraint. In `OPEN_SECTION` both rows
    // are ungated, so the check rule fails there; only `SPLIT_SECTION` satisfies both.
    expect(gatePath(OPEN_SECTION, soleIndex(OPEN_SECTION, ROW.updateCheck))).toEqual([])
    expect(gatePath(SPLIT_SECTION, soleIndex(SPLIT_SECTION, ROW.releaseNotes))).toEqual([])
    expect(gatePath(SPLIT_SECTION, soleIndex(SPLIT_SECTION, ROW.updateCheck))).toEqual(["desktop()"])
  })

  test("negative control — an unresolvable gate throws instead of reporting no gate", () => {
    // The failure mode that made the old guard useless was answering "fine" when it meant "I did not
    // look". A section rendered from two places has no single gate, so the resolver must say so.
    expect(() => gatePath(RENDERED_TWICE, soleIndex(RENDERED_TWICE, ROW.releaseNotes))).toThrow(/rendered in 2 places/)
  })

  test("negative control — comments and strings cannot fake a gate", () => {
    // `blankNonCode` is what stops a `<Show when={desktop()}>` written inside a comment (both panels
    // carry long explanatory comments right at this spot) from being read as a real gate.
    const commented = GATED_SECTION.replace(
      "  const UpdatesSection = () => (",
      '  // <Show when={desktop()}> and a "quoted <Show when={mobile()}>" string\n  const UpdatesSection = () => (',
    )
    expect(gatePath(commented, soleIndex(commented, ROW.releaseNotes))).toEqual(["desktop()"])
  })
})
