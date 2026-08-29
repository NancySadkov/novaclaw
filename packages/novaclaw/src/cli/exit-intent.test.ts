import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ExitIntent } from "./exit-intent"

// The child half of the watchdog protocol. The Rust side's own tests cover the READER; these cover
// the writer, and above all the two properties that decide whether the pair is safe:
//
//   1. an UNSUPERVISED run must behave exactly as it did before the watchdog existed;
//   2. a failed write must never yield the reserved code, because that is half a promise — the clean
//      status with no document, which the reader treats as a crash anyway.

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "intent-"))
const WATCHED = (dir: string) => ({ NOVACLAW_WATCHDOG_STATE: dir })

describe("stateDir", () => {
  test("absent env means nothing is supervising", () => {
    expect(ExitIntent.stateDir({})).toBeUndefined()
  })

  // ⚠️ An EMPTY string is not a directory. Left untreated it would produce `path.join("", …)`, which
  // resolves relative to the cwd — an intent file written somewhere nobody reads.
  test("an empty value is not a directory", () => {
    expect(ExitIntent.stateDir({ NOVACLAW_WATCHDOG_STATE: "" })).toBeUndefined()
  })

  test("a set value is the state directory", () => {
    expect(ExitIntent.stateDir({ NOVACLAW_WATCHDOG_STATE: "/x/y" })).toBe("/x/y")
  })
})

describe("settle", () => {
  // 🔴 THE PROPERTY THAT PROTECTS EVERY EXISTING CALLER. Exiting 77 on an ordinary Ctrl-C when no
  // watchdog is listening would change the status every script, CI job and shell sees.
  test("unsupervised: returns the historical code and writes NOTHING", () => {
    const dir = tmp()
    // The env says nothing is supervising, so even a real directory must be left alone.
    expect(ExitIntent.settle({ kind: "shutdown" }, 0, {})).toBe(0)
    expect(existsSync(path.join(dir, "exit-intent.json"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("unsupervised: a non-zero historical code is preserved too", () => {
    expect(ExitIntent.settle({ kind: "shutdown" }, 3, {})).toBe(3)
  })

  test("supervised: returns the reserved code and writes the document", () => {
    const dir = tmp()
    expect(ExitIntent.settle({ kind: "shutdown" }, 0, WATCHED(dir))).toBe(ExitIntent.EXIT_CODE)
    expect(JSON.parse(readFileSync(path.join(dir, "exit-intent.json"), "utf8"))).toEqual({ kind: "shutdown" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("supervised: a dormant intent carries its absolute wake time", () => {
    const dir = tmp()
    const wakeAtMs = 1787961234567
    expect(ExitIntent.settle({ kind: "dormant", wakeAtMs }, 0, WATCHED(dir))).toBe(ExitIntent.EXIT_CODE)
    expect(JSON.parse(readFileSync(path.join(dir, "exit-intent.json"), "utf8"))).toEqual({
      kind: "dormant",
      wakeAtMs,
    })
    rmSync(dir, { recursive: true, force: true })
  })

  // 🔴 A FAILED WRITE MUST NOT RETURN 77. The reserved code without a document is the clean status
  // with nothing behind it: the reader treats it as a crash regardless, but emitting it would mean
  // this side claimed to have left instructions it did not leave.
  test("a write that cannot succeed falls back to the historical code", () => {
    const dir = tmp()
    // A FILE where the state directory should be: mkdir and the write both fail.
    const blocked = path.join(dir, "blocked")
    writeFileSync(blocked, "not a directory")
    expect(ExitIntent.settle({ kind: "shutdown" }, 0, WATCHED(blocked))).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  test("write never throws, whatever the path", () => {
    expect(() => ExitIntent.write("\0:/nonsense", { kind: "shutdown" })).not.toThrow()
    expect(ExitIntent.write("\0:/nonsense", { kind: "shutdown" })).toBe(false)
  })

  // ⚠️ The temp file must not survive: a stray `exit-intent.json.tmp` is harmless to the reader but
  // it is litter in a directory the watchdog scans, and its presence would mean the rename failed.
  test("the atomic temp file does not survive a successful write", () => {
    const dir = tmp()
    ExitIntent.write(dir, { kind: "restart" })
    expect(existsSync(path.join(dir, "exit-intent.json"))).toBe(true)
    expect(existsSync(path.join(dir, "exit-intent.json.tmp"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("it creates the state directory if the watchdog has not yet", () => {
    const parent = tmp()
    const dir = path.join(parent, "deep", "state")
    expect(ExitIntent.settle({ kind: "shutdown" }, 0, WATCHED(dir))).toBe(ExitIntent.EXIT_CODE)
    expect(existsSync(path.join(dir, "exit-intent.json"))).toBe(true)
    rmSync(parent, { recursive: true, force: true })
  })

  // ⚠️ The wire format is a CONTRACT with a program in another language that parses it by hand.
  // Anything but a flat object with these exact keys is a break the Rust side cannot see.
  test("the serialised form is exactly what the Rust reader parses", () => {
    expect(ExitIntent.serialise({ kind: "shutdown" })).toBe('{"kind":"shutdown"}')
    expect(ExitIntent.serialise({ kind: "restart" })).toBe('{"kind":"restart"}')
    expect(ExitIntent.serialise({ kind: "dormant", wakeAtMs: 5 })).toBe('{"kind":"dormant","wakeAtMs":5}')
  })
})

describe("the reserved code agrees with the reader", () => {
  // 🔴 A CROSS-LANGUAGE CONSTANT WITH TWO DEFINITIONS. Nothing in either compiler can see the other,
  // so the only guard available is to read the Rust source and check the number still matches.
  test("EXIT_CODE equals INTENT_EXIT_CODE in the watchdog", () => {
    const rust = path.join(import.meta.dir, "..", "..", "..", "watchdog", "src", "main.rs")
    const source = readFileSync(rust, "utf8")
    const found = /const INTENT_EXIT_CODE: i32 = (\d+);/.exec(source)
    expect(found, "could not find INTENT_EXIT_CODE in the watchdog source").not.toBeNull()
    expect(Number(found![1])).toBe(ExitIntent.EXIT_CODE)
  })

  test("the env var this side reads is the one the watchdog sets", () => {
    const rust = path.join(import.meta.dir, "..", "..", "..", "watchdog", "src", "main.rs")
    expect(readFileSync(rust, "utf8")).toContain("NOVACLAW_WATCHDOG_STATE")
  })
})

// Keep the import used on platforms where the blocked-path case cannot be constructed.
void mkdirSync
