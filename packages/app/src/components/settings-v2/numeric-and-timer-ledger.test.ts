import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { stripComments } from "@/utils/strip-comments"

/**
 * **Two shrink-only ledgers over the settings panels, for two classes this directory produced twice
 * each.** Both may only go DOWN, and a file that reaches zero loses its line — a stale entry fails as
 * loudly as a new one, so neither can rot into a rubber stamp.
 *
 * **A — a hand-rolled number box.** The class: *a control that writes on every keystroke, coercing
 * the in-progress value*, so the intermediate state a user must pass THROUGH to reach a legal one is
 * clamped or truncated away. It appeared as three per-keystroke clamps on the Tunes tab (typing `512`
 * into a `min="64"` box persisted **64**, and the echoed store rewrote the box) and as a `parsed > 1`
 * one keystroke away from the `min="1"` printed on the same element in Strict's Attempts row (typing
 * the documented `1` stored `0`). Both were written by copying a neighbour, which is what a ledger
 * over the population is for. {@link NUMBER_FIELD} is the shared control that owns commit-on-change,
 * a range that cannot disagree with the element's own attributes, and a visible refusal instead of a
 * silent clamp.
 *
 * ⚠️ **The remaining entries are not all bugs, and this ledger does not claim they are.** It records
 * what exists so the next one fails the gate. `messengers.tsx`'s pace box is the clearest defensible
 * line: it commits per keystroke into a LOCAL signal inside a dialog and only reaches the server when
 * the dialog is saved, which is exactly the case `parts/preset-field.tsx` documents as the reason its
 * own `commit` default is `"input"`.
 *
 * **B — a timer nobody can cancel.** The class: *a scheduled effect whose handle lives outside any
 * component's lifecycle.* The sound demo kept its `setTimeout` in a module-level `let`, so hovering an
 * option and closing Settings inside 100 ms played a sound into a panel that was gone. A file that
 * schedules and never registers an `onCleanup` has, by construction, no way to stop what it started.
 *
 * ⚠️ The check is per FILE rather than per call site, deliberately: proximity matching ("is there an
 * `onCleanup` near this `setTimeout`?") fires on normal code, and a threshold that fires on normal is
 * not a threshold. The two remaining entries were read and are both `setTimeout(…, 0)`-shaped local
 * conveniences (revoking an object URL, resetting a "Copied" label), not subsystem work.
 */

const DIR = import.meta.dir
/** The one place a settings number box may be built. */
const NUMBER_FIELD = "parts/number-field.tsx"

/** Measured against this directory on 2026-09-02. Every number may only DECREASE. */
const RAW_NUMBER_BOXES: Record<string, number> = {
  "messengers.tsx": 1,
}

/** Timer schedules in a file that never registers an `onCleanup`. Measured the same day. */
const UNOWNED_TIMERS: Record<string, number> = {
  "identity.tsx": 2,
  "memory.tsx": 1,
}

function panels(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith(".tsx")) continue
      out.push({ name: relative(DIR, full).split("\\").join("/"), text: stripComments(readFileSync(full, "utf8")) })
    }
  }
  walk(resolve(DIR))
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0

describe("settings panels — the hand-rolled number box", () => {
  test("only the shared field builds one, and the remaining population only shrinks", () => {
    const found: Record<string, number> = {}
    for (const panel of panels()) {
      if (panel.name === NUMBER_FIELD) continue
      const n = count(panel.text, /type="number"/g)
      if (n > 0) found[panel.name] = n
    }
    // Reported as a whole object so a run names every drift at once rather than stopping at the first.
    expect(found).toEqual(RAW_NUMBER_BOXES)
  })

  test("the shared field is real, and it commits on change only", () => {
    const field = panels().find((p) => p.name === NUMBER_FIELD)
    expect(field).toBeDefined()
    expect(count(field!.text, /onChange=/g)).toBe(1)
    // The whole point: there is no per-keystroke path for a caller to reach.
    expect(count(field!.text, /onInput=/g)).toBe(0)
  })

  test("the one raw number box is a local dialog draft and uses the shared refusal parser", () => {
    const messenger = panels().find((p) => p.name === "messengers.tsx")
    expect(messenger).toBeDefined()
    expect(messenger!.text).toContain("parseSettingsNumber(cps(), { min: PACE_MIN, max: PACE_MAX })")
    expect(messenger!.text).toContain('setError(language.t("settings.field.number.range"')
  })
})

describe("settings panels — a timer nobody can cancel", () => {
  test("a file that schedules work registers a cleanup, and the exceptions only shrink", () => {
    const found: Record<string, number> = {}
    for (const panel of panels()) {
      if (/\bonCleanup\s*\(/.test(panel.text)) continue
      const n = count(panel.text, /\b(?:setTimeout|setInterval)\s*\(/g)
      if (n > 0) found[panel.name] = n
    }
    expect(found).toEqual(UNOWNED_TIMERS)
  })

  test("the Appearance panel's sound demo is owned, and the panel actually builds one", () => {
    const appearance = panels().find((p) => p.name === "appearance.tsx")
    expect(appearance).toBeDefined()
    const text = appearance!.text
    // No module-level handle: every schedule in the file lives inside the owning factory, and the
    // factory registers its own cleanup.
    const factory = text.slice(text.indexOf("createDemoSound = ()"), text.indexOf("const FONT_CUSTOM"))
    expect(factory).toContain("onCleanup(stop)")
    expect(count(text, /\bsetTimeout\s*\(/g)).toBe(count(factory, /\bsetTimeout\s*\(/g))
    // ⚠️ And it is CALLED. A cancel mechanism nothing constructs is a fix that never runs.
    const panel = text.slice(text.indexOf("export const SettingsAppearanceV2"))
    expect(panel).toContain("createDemoSound()")
  })
})
