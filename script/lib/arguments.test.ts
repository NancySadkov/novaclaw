import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import * as Arguments from "./arguments"

describe("test runner arguments", () => {
  test("no arguments is the fast tier, and is not a refusal", () => {
    expect(Arguments.unrecognizedArguments([])).toEqual([])
    expect(Arguments.isHelp([])).toBe(false)
    expect(Arguments.only([])).toBeUndefined()
  })

  test("the flags the runner implements are recognized", () => {
    for (const argv of [["--full"], ["--only=core"], ["--only=typecheck"], ["--help"], ["-h"], ["--force"]])
      expect(Arguments.unrecognizedArguments(argv), argv.join(" ")).toEqual([])
  })

  test("🔴 `--list` and `--help`-shaped guesses are REFUSED, not silently run as the whole suite", () => {
    // Measured 2026-09-15: `bun run test --list` ran a full 23-unit tier and left a stray `bun`
    // that then refused three unrelated units. This is the regression the whole module exists for.
    expect(Arguments.unrecognizedArguments(["--list"])).toEqual(["--list"])
    expect(Arguments.unrecognizedArguments(["--ls"])).toEqual(["--ls"])
    expect(Arguments.unrecognizedArguments(["--flull"])).toEqual(["--flull"])
  })

  test("🔴 `--only core` without the equals sign is refused — the plausible typo, not a valid form", () => {
    // Both halves are unrecognized, and the refusal names them: the runner must not read `--only`
    // as "no filter", which is what silently ran everything.
    expect(Arguments.unrecognizedArguments(["--only", "core"])).toEqual(["--only", "core"])
    expect(Arguments.only(["--only", "core"])).toBeUndefined()
  })

  test("every unrecognized argument is reported, in order", () => {
    expect(Arguments.unrecognizedArguments(["--list", "--only=core", "--wat"])).toEqual(["--list", "--wat"])
  })

  test("`--only=` reads the unit, and an empty value is treated as absent", () => {
    expect(Arguments.only(["--only=core"])).toBe("core")
    expect(Arguments.only(["--only=novaclaw:server"])).toBe("novaclaw:server")
    expect(Arguments.only(["--only="])).toBeUndefined()
  })

  test("help is answered even when a bad argument rides along", () => {
    // Asking for help must never start a run, whatever else was typed on the line.
    expect(Arguments.isHelp(["--help", "--list"])).toBe(true)
  })

  test("the refusal names the offender and points at the form that works", () => {
    const message = Arguments.refusal(["--only", "core"])
    expect(message).toContain("--only")
    expect(message).toContain("core")
    expect(message).toContain("--only=<unit>")
    expect(Arguments.refusal(["--list"])).toContain("Unrecognized argument:")
    expect(Arguments.refusal(["--list", "--wat"])).toContain("Unrecognized arguments:")
  })

  test("the usage text documents every flag the runner implements", () => {
    // A flag that works but is not printed is a flag nobody can find; this is the ratchet that
    // fails when one is added to DOCUMENTED_FLAGS without a line here.
    for (const flag of Arguments.DOCUMENTED_FLAGS) expect(Arguments.USAGE, flag).toContain(flag)
    expect(Arguments.USAGE).toContain("--only=<unit>")
  })

  test("`--force` is accepted but NOT advertised, because it does nothing here", () => {
    // It is documented in doc/pitfalls.md for the BUILD guard. Printing it in this runner's usage
    // would advertise a lever the user cannot pull — the same defect as a setting that lies about
    // being in force. It must still start the run rather than be refused by name.
    expect(Arguments.unrecognizedArguments(["--force"])).toEqual([])
    expect(Arguments.USAGE).not.toContain("--force")
    expect([...Arguments.ACCEPTED_INERT_FLAGS]).toEqual(["--force"])
  })

  test("heavy-guard's own override is accepted here, so a documented command still starts", () => {
    // `test.ts` refuses to bypass its memory gate (`allowOverride: false`), so `--force` is INERT
    // for the suite — but it is documented in doc/pitfalls.md and read by the build guard, so
    // refusing it by name would break a command someone is told to type.
    const source = readFileSync(join(import.meta.dir, "heavy-guard.ts"), "utf8")
    const flags = [...source.matchAll(/"(--[a-z-]+)"/g)].map((match) => match[1]!)
    expect(flags.length, "heavy-guard.ts no longer names any flag; re-derive this guard").toBeGreaterThan(0)
    for (const flag of flags) expect([...Arguments.FLAGS], flag).toContain(flag)
  })

  test("the runner reads argv through this module, never around it", () => {
    // 🔴 The door this closes: a future `process.argv.includes("--newflag")` added straight to the
    // runner would be refused by the validator even though the code below honours it — a flag that
    // works and is rejected. One sanctioned read keeps the two from drifting.
    const source = readFileSync(join(import.meta.dir, "..", "test.ts"), "utf8")
    const reads = source.match(/process\.argv/g) ?? []
    expect(reads.length, "script/test.ts reads process.argv more than once; route it through lib/arguments").toBe(2)
  })
})
