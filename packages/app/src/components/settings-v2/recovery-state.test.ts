import { describe, expect, test } from "bun:test"
import { ConfigHarnessDrives } from "@novaclaw/core/config/harness-drives"
import { dict as en } from "@/i18n/en"
import { resumeInterruptedOn, resumeInterruptedPatch } from "./recovery-state"

// The Health & recovery surface's ratchet. Three ways this row goes silently wrong, one test each:
//
//   1. It disagrees with the KERNEL about what an unset key means, so the switch shows a position the
//      instance is not in.
//   2. It clobbers its neighbours in a config block it only owns one field of.
//   3. It renders a missing i18n key at a person who is already having a bad day.

const keys = new Set(Object.keys(en))

describe("resumeInterruptedOn", () => {
  /**
   * 🔴 DRIVEN FROM THE KERNEL, never restated here. `ConfigHarnessDrives.resolve` is the authority on
   * what an unset key means; comparing against a hand-written `true` would keep passing on the day
   * core changed its default, which is precisely the drift a ratchet exists to catch.
   */
  test("agrees with the kernel that an ABSENT key means ON", () => {
    expect(ConfigHarnessDrives.resolve(undefined).resumeInterrupted).toBe(true)
    expect(resumeInterruptedOn(undefined)).toBe(true)
    expect(resumeInterruptedOn({})).toBe(true)
    expect(resumeInterruptedOn({ harness_drives: {} })).toBe(true)
  })

  // ⚠️ The gesture this protects: a user who flips a wrongly-OFF switch on and then off again has
  // turned the feature off believing they left it alone. The switch would have lied twice.
  test("an explicit false is OFF, and an explicit true is ON", () => {
    expect(resumeInterruptedOn({ harness_drives: { resumeInterrupted: false } })).toBe(false)
    expect(resumeInterruptedOn({ harness_drives: { resumeInterrupted: true } })).toBe(true)
    expect(ConfigHarnessDrives.resolve({ resumeInterrupted: false }).resumeInterrupted).toBe(false)
  })

  test("the surface and the kernel answer alike for every shape", () => {
    const shapes = [undefined, {}, { resumeInterrupted: true }, { resumeInterrupted: false }] as const
    for (const shape of shapes)
      expect(resumeInterruptedOn(shape === undefined ? undefined : { harness_drives: shape })).toBe(
        ConfigHarnessDrives.resolve(shape).resumeInterrupted,
      )
  })
})

describe("resumeInterruptedPatch", () => {
  // 🔴 `harness_drives` carries other switches. Writing this field alone would clear whichever
  // of them an operator had set — a setting silently turning OFF three others is the worst kind of
  // config bug, because nothing points at the screen that did it.
  test("preserves the sibling switches it does not own", () => {
    const config = { harness_drives: { reground: false, imageShortcut: false } }
    expect(resumeInterruptedPatch(config, true)).toEqual({
      harness_drives: { reground: false, imageShortcut: false, resumeInterrupted: true },
    })
  })

  test("writes the field on an instance that has no block yet", () => {
    expect(resumeInterruptedPatch(undefined, false)).toEqual({ harness_drives: { resumeInterrupted: false } })
  })

  test("an explicit false is written, not omitted", () => {
    // ⚠️ Omitting it would mean OFF could never be expressed: absent reads as ON.
    expect(resumeInterruptedPatch({ harness_drives: {} }, false).harness_drives.resumeInterrupted).toBe(false)
  })
})

describe("the copy exists", () => {
  // ⚠️ A missing key renders as the key itself, to a person who opened this tab because something
  // was wrong. Cheap to check, and the check is why it will not happen.
  for (const key of [
    "settings.recovery.section.afterCrash",
    "settings.recovery.row.resumeInterrupted.title",
    "settings.recovery.row.resumeInterrupted.description",
    "settings.recovery.row.resumeInterrupted.description.more",
  ])
    test(key, () => expect(keys.has(key)).toBe(true))

  // 🔴 Principle 12(c): human units, no jargon. The row is read by someone who is worried, not by
  // whoever named the config key — so the identifier must not leak into what they see.
  test("the visible copy names no identifiers", () => {
    const visible = [
      en["settings.recovery.section.afterCrash"],
      en["settings.recovery.row.resumeInterrupted.title"],
      en["settings.recovery.row.resumeInterrupted.description"],
    ].join(" ")
    for (const jargon of ["resumeInterrupted", "harness_drives", "lease", "drain", "execution attempt"])
      expect(visible.toLowerCase()).not.toContain(jargon.toLowerCase())
  })
})
