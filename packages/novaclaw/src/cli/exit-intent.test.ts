import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs"
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

  test("a set value inside an explicit trusted root is the state directory", () => {
    const root = tmp()
    const dir = path.join(root, "watchdog")
    expect(ExitIntent.stateDir(WATCHED(dir), [root])).toBe(dir)
    rmSync(root, { recursive: true, force: true })
  })

  test("a relative or sibling path cannot acquire write authority from the environment", () => {
    const parent = tmp()
    const root = path.join(parent, "allowed")
    mkdirSync(root)
    expect(ExitIntent.stateDir(WATCHED("relative/watchdog"), [root])).toBeUndefined()
    expect(ExitIntent.stateDir(WATCHED(path.join(parent, "sibling")), [root])).toBeUndefined()
    rmSync(parent, { recursive: true, force: true })
  })

  test("the default policy rejects a filesystem root", () => {
    const root = path.parse(os.tmpdir()).root
    expect(ExitIntent.stateDir(WATCHED(root))).toBeUndefined()
  })

  test("canonical containment rejects a directory symlink that escapes its trusted root", () => {
    const parent = tmp()
    const root = path.join(parent, "allowed")
    const outside = path.join(parent, "outside")
    mkdirSync(root)
    mkdirSync(outside)
    const link = path.join(root, "escape")
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
    expect(ExitIntent.stateDir(WATCHED(path.join(link, "watchdog")), [root])).toBeUndefined()
    rmSync(parent, { recursive: true, force: true })
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

  test("an untrusted environment path falls back without creating protocol files", () => {
    const parent = tmp()
    const root = path.join(parent, "allowed")
    const outside = path.join(parent, "outside")
    mkdirSync(root)
    expect(ExitIntent.settle({ kind: "shutdown" }, 4, WATCHED(outside), [root])).toBe(4)
    expect(existsSync(outside)).toBe(false)
    rmSync(parent, { recursive: true, force: true })
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

/**
 * ── THE STATE DIRECTORY IS ONE EDGE, NOT A LINEAGE ───────────────────────────────────────────────
 *
 * `serve --supervise` is a supervisor running under a watchdog, so the real topology is
 * watchdog → supervisor → server. `NOVACLAW_WATCHDOG_STATE` tells a process where the watchdog
 * DIRECTLY ABOVE IT is listening; inherited one level further it lets the innermost server answer a
 * question that was asked of the supervisor.
 *
 * 🔴 The failure is silent and points the wrong way. The server stops cleanly, writes `shutdown`,
 * and the document outlives it. Later the SUPERVISOR dies of something real — an OOM, a crash — and
 * the watchdog finds an intent saying the stop was deliberate. It stays down. An instance lost
 * forever to a stale note written by the wrong process is the exact outcome the watchdog exists to
 * prevent.
 */
describe("childEnv", () => {
  test("removes the watchdog's state directory and nothing else", () => {
    const env = { PATH: "/usr/bin", NOVACLAW_WATCHDOG_STATE: "/tmp/wd", HOME: "/home/nancy" }
    expect(ExitIntent.childEnv(env)).toEqual({ PATH: "/usr/bin", HOME: "/home/nancy" })
  })

  test("an unsupervised environment passes through untouched", () => {
    const env = { PATH: "/usr/bin", HOME: "/home/nancy" }
    expect(ExitIntent.childEnv(env)).toEqual(env)
  })

  // ⚠️ `Bun.spawn` rejects an `undefined` value where a string is declared, and `process.env` on
  // Windows readily contains holes. Dropping them is what makes this a drop-in for `process.env`.
  test("drops undefined values rather than handing them to a spawn", () => {
    expect(ExitIntent.childEnv({ A: "1", B: undefined })).toEqual({ A: "1" })
  })

  // 🔴 The round trip, stated as the property that actually matters: whatever `childEnv` returns,
  // a process reading it must conclude nothing is supervising it.
  test("a child reading the scrubbed environment sees no watchdog", () => {
    expect(ExitIntent.stateDir(ExitIntent.childEnv({ NOVACLAW_WATCHDOG_STATE: "/tmp/wd" }))).toBeUndefined()
  })
})

/**
 * ── THE WIRING, WHICH THE TESTS ABOVE DO NOT TOUCH ───────────────────────────────────────────────
 *
 * Every test above passes with `serve.ts` still handing `process.env` straight to `Bun.spawn`. This
 * session has already shipped that mistake twice — a helper proven in isolation and never actually
 * called — so the call site is asserted directly. It reads source because the alternative is booting
 * a real supervisor and inspecting a grandchild's environment on Windows, which is not a unit test.
 *
 * ⚠️ Being a text test, it asserts its ANCHOR was found before drawing any conclusion: a pattern
 * that matches nothing must not read as a pattern that matched something correct.
 */
describe("the supervisor's spawn is wired to it", () => {
  const serve = () =>
    readFileSync(path.join(import.meta.dir, "cmd", "serve.ts"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n")

  test("serve.ts spawns its child through childEnv, never with a bare process.env", () => {
    const source = serve()
    expect(source, "the spawn moved — this test must be re-pointed, not deleted").toContain("Bun.spawn(cmd, {")
    expect(source).toContain("env: ExitIntent.childEnv(process.env)")
    expect(source).not.toContain("env: process.env as Record<string, string>")
  })

  // The other half of the pair. Landing intent-emission WITHOUT the scrub is what arms the trap, so
  // the two are pinned together and a future edit cannot quietly keep one.
  test("and the plain server emits a shutdown intent, which is only safe because of the scrub", () => {
    expect(serve()).toContain('ExitIntent.settle({ kind: "shutdown" }, 0)')
  })
})
