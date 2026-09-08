import { describe, expect, test } from "bun:test"
import { ConfigHarnessDrives } from "./harness-drives"

// The harness-drive switches make a true unaided baseline possible: `reground` must be disabled,
// which is an app change no prompt can make.
//
// 🔴 The defect this file guards against is a SIGN ERROR, and it is the expensive one. `Config.latest`
// answers `undefined` for a key nobody set, so reading absence as "off" would silently disable all
// the live drives on every instance in the world — a change that makes the product quietly worse and
// that no gate would notice, because every test asserting a drive FIRES would simply stop running it.

describe("resolve", () => {
  // ⭐ THE CRITICAL DIRECTION. An unset block must behave exactly as the harness did before this key
  // existed, or shipping the switch is itself the regression.
  test("an absent block leaves every live drive ON", () => {
    expect(ConfigHarnessDrives.resolve(undefined)).toEqual({
      reground: true,
      set: false,
      children: true,
      imageShortcut: true,
      resumeInterrupted: true,
    })
  })

  test("an empty block leaves every live drive ON", () => {
    expect(ConfigHarnessDrives.resolve({})).toEqual({
      reground: true,
      set: false,
      children: true,
      imageShortcut: true,
      resumeInterrupted: true,
    })
  })

  test("a malformed stored block leaves every live drive ON", () => {
    const enabled = {
      reground: true,
      set: false,
      children: true,
      imageShortcut: true,
      resumeInterrupted: true,
    } as const
    for (const malformed of [null, [], { resumeInterrupted: 0 }, { resumeInterrupted: "false" }, { reground: 1 }]) {
      expect(ConfigHarnessDrives.resolve(malformed)).toEqual(enabled)
    }
  })

  test("an explicit false survives — it is not read as absent", () => {
    expect(ConfigHarnessDrives.resolve({ reground: false })).toEqual({
      reground: false,
      set: false,
      children: true,
      imageShortcut: true,
      resumeInterrupted: true,
    })
  })

  test("an explicit true is honoured", () => {
    expect(ConfigHarnessDrives.resolve({ reground: true })).toEqual({
      reground: true,
      set: false,
      children: true,
      imageShortcut: true,
      resumeInterrupted: true,
    })
  })

  // ⚠️ Each live switch is independent. The stale `set` key below is deliberately inert.
  test("switches are independent", () => {
    expect(ConfigHarnessDrives.resolve({ reground: false, set: true, children: false })).toEqual({
      reground: false,
      set: false,
      children: false,
      imageShortcut: true,
      resumeInterrupted: true,
    })
  })

  test("the retired set drive stays off even when an old settings record enables it", () => {
    expect(
      ConfigHarnessDrives.resolve({
        reground: false,
        set: true,
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
