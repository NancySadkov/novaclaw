import { describe, expect, test } from "bun:test"
import { ConfigHarnessDrives } from "./harness-drives"

// The harness-drive switches — `todo/batch-file-planning.md`'s first 🔴: *a TRUE UNAIDED BASELINE
// needs `reground` disabled, which is an app change nobody has made.*
//
// 🔴 The defect this file guards against is a SIGN ERROR, and it is the expensive one. `Config.latest`
// answers `undefined` for a key nobody set, so reading absence as "off" would silently disable all
// four drives on every instance in the world — a change that makes the product quietly worse and
// that no gate would notice, because every test asserting a drive FIRES would simply stop running it.

describe("resolve", () => {
  // ⭐ THE CRITICAL DIRECTION. An unset block must behave exactly as the harness did before this key
  // existed, or shipping the switch is itself the regression.
  test("an absent block leaves every drive ON", () => {
    expect(ConfigHarnessDrives.resolve(undefined)).toEqual({ reground: true, set: true, children: true, imageShortcut: true, resumeInterrupted: true })
  })

  test("an empty block leaves every drive ON", () => {
    expect(ConfigHarnessDrives.resolve({})).toEqual({ reground: true, set: true, children: true, imageShortcut: true, resumeInterrupted: true })
  })

  test("an explicit false survives — it is not read as absent", () => {
    expect(ConfigHarnessDrives.resolve({ reground: false })).toEqual({
      reground: false,
      set: true,
      children: true,
      imageShortcut: true,
      resumeInterrupted: true,
    })
  })

  test("an explicit true is honoured", () => {
    expect(ConfigHarnessDrives.resolve({ reground: true })).toEqual({
      reground: true,
      set: true,
      children: true,
      imageShortcut: true,
      resumeInterrupted: true,
    })
  })

  // ⚠️ Each switch is INDEPENDENT. The unaided baseline needs `reground` off while the set drive's
  // state is decided separately by the rig's prompt arm, so one switch must never move another.
  test("switches are independent", () => {
    expect(ConfigHarnessDrives.resolve({ reground: false, set: true, children: false })).toEqual({
      reground: false,
      set: true,
      children: false,
      imageShortcut: true,
      resumeInterrupted: true,
    })
  })

  test("all four can be off at once — the fully unaided configuration", () => {
    expect(
      ConfigHarnessDrives.resolve({
        reground: false,
        set: false,
        children: false,
        imageShortcut: false,
        resumeInterrupted: false,
      }),
    ).toEqual({
      reground: false,
      set: false,
      children: false,
      imageShortcut: false,
      resumeInterrupted: false,
    })
  })
})
