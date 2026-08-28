import { describe, expect, test } from "bun:test"
import { mkdirSync, readdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import path, { join, parse } from "node:path"
import { Global } from "@novaclaw/core/global"
import { Scratch } from "@novaclaw/core/scratch"
import { SCRATCH_ROOT, scratchHome } from "@novaclaw/core/kb-graph/wasm-engine"
import { tmpdir } from "./fixture/tmpdir"

// AGENTS.md design principle 11: outside the home, the OS temp dir and the working folder, the
// filesystem is READ-ONLY to us. This is the mechanical half — the principle on its own is the class
// of claim ruling 1 says does not exist unless something fails when it is violated.
//
// The instance that produced it: the KB memory engine littered the drive root with one `kbmem_<pid>`
// directory per open (129 of them / 249 MB at the worst), then with a `C:\novaclaw-kbmem` junction
// once that was "fixed". Both were invisible to every test, because nothing looked outside the tree.

describe("design principle 11: we do not write outside the home", () => {
  test("the KB scratch root resolves inside the instance home, not at the drive root", () => {
    // On win32 SCRATCH_ROOT is `scratchHome()` with the drive letter stripped, so it must keep every
    // other segment. A single-segment root path IS the drive root and is the bug this pins.
    expect(SCRATCH_ROOT.split("/").filter(Boolean).length).toBeGreaterThan(1)

    // …and it must be the SAME directory as the home path, not merely a deep-looking one.
    const home = scratchHome().replaceAll("\\", "/")
    const stripped = home.replace(/^[A-Za-z]:/, "")
    expect(SCRATCH_ROOT.replaceAll("\\", "/")).toBe(process.platform === "win32" ? stripped : home)
  })

  test("the scratch home is under the instance cache dir", () => {
    const cache = Global.Path.cache.replaceAll("\\", "/")
    expect(scratchHome().replaceAll("\\", "/").startsWith(cache)).toBe(true)
  })

  test("the engine is never handed a drive-lettered path (it fails getcwd) nor a backslash one", () => {
    expect(SCRATCH_ROOT).not.toMatch(/^\/?[A-Za-z]:/)
    expect(SCRATCH_ROOT).not.toContain("\\")
    expect(SCRATCH_ROOT.startsWith("/")).toBe(true)
  })

  test("no novaclaw-shaped entry is left at the root of the current drive", () => {
    // The regression is observable from outside the tree or not at all — that is why it survived two
    // rounds of "fixes". Scoped to our own names so an unrelated C:\ entry can never fail the gate.
    const driveRoot = parse(process.cwd()).root
    let entries: string[]
    try {
      entries = readdirSync(driveRoot)
    } catch {
      return // unreadable root (CI container, permissions) — nothing to assert
    }
    const ours = entries.filter((n) => /^(kbmem_|novaclaw-kbmem)/i.test(n))
    expect(ours).toEqual([])
  })

  test("nothing of ours is left loose at the TOP LEVEL of the home directory", () => {
    // 🔴 The third instance of this class, and the third one a HUMAN found rather than a test (owner,
    // 2026-08-18): `C:\Users\nangl\nc-verify-ok\` and `nc-verify-bad\` — an agent's recipe-verify
    // fixtures, cooked straight into the owner's home instead of `tmp/`. Before this, the sweep looked
    // at the drive root and at nullish segments; the home's own top level was the gap, which is
    // unfortunate because it is the likeliest landing spot: `os.homedir()` is the easiest absolute
    // path to reach for, and on Windows `C:\Users\<user>` looks harmlessly like "somewhere temporary".
    //
    // ⚠️ Principle 11 permits the home — but it permits the INSTANCE DIRS in it (`$XDG_*`,
    // `%APPDATA%\novaclaw*`, `~/.cache/novaclaw`, `NOVACLAW_HOME`), every one of them nested under a
    // dot-directory or AppData. A bare working folder sitting beside the user's Documents is not one
    // of the three permitted places, and there is explicitly no "just a scratch file" exemption.
    //
    // ⚠️ Scoped to OUR OWN naming shapes, deliberately, for the same reason the drive-root sweep is: a
    // whitelist of "normal" home contents is machine-specific and unbounded (this one holds Calibre,
    // VirtualBox, a dozen tool dot-dirs), so a sweep that failed on anything unrecognised would be red
    // everywhere and get deleted rather than obeyed. The honest limit is stated rather than hidden:
    // this catches the names WE reach for, and cannot catch an agent inventing an unrelated one.
    let entries: string[]
    try {
      entries = readdirSync(homedir())
    } catch {
      return // unreadable home — nothing to assert
    }
    const ours = entries.filter(
      (name) =>
        // `nc-*` and `novaclaw*`: an instance home belongs at `~/.local/share/novaclaw`, never at `~/novaclaw`.
        // `undefined`/`null`: the stringified-path bug, so its residue is caught here too.
        /^(nc-|novaclaw|kbmem_|novaclaw-kbmem)/i.test(name) || /^(undefined|null)$/i.test(name),
    )
    expect(
      ours,
      [
        "Loose NovaClaw-shaped entries at the top level of the home directory:",
        ...ours.map((name) => `  ${join(homedir(), name)}`),
        "",
        "  Scratch belongs in the repo's `tmp/`; instance state belongs in an XDG/AppData directory.",
        "  See AGENTS.md principle 11 — there is no fourth location and no scratch-file exemption.",
      ].join("\n"),
    ).toEqual([])
  })
})

// ── the second instance of the same class: a stringified `undefined` as a path segment ───────────
//
// Found 2026-08-18, the same way principle 11's first one was — by looking at the owner's drive, not
// by any test. `C:\Users\nangl\undefined\novaclaw` held `novaclaw.db` (409 KB), `novaclaw-dev.db`, a
// `memory/graph` (1.9 MB), `recipes/`, `log/` and `scratch/`: six days of a real instance, written
// into a folder named after a JavaScript value. `String(undefined)` is an ordinary non-empty string,
// so `path.join` takes it and every `??`/`||` downstream skips its fallback.
//
// The data-directory half was fixed in f232051a0 (2026-07-27) and that stray is residue. But the
// TEMP root was still live when this block was written: `os.tmpdir()` returns TMPDIR/TMP/TEMP
// verbatim, and `tmp` was the one of the seven instance directories that never went through
// `Xdg.isSuspect`. With `TEMP="undefined"`, `Global.Path.tmp` was the RELATIVE `"undefined\novaclaw"`
// and `ensureDirectories` created it under the process's cwd — the user's project folder — while
// `directoryStatus()` still said `ok`.
//
// NEGATIVE CONTROL, measured 2026-08-18 (win32) by reverting each guard and re-running this file.
// ⚠️ Read the last two rows before "improving" any single guard away: the defences OVERLAP, and
// removing one on its own is absorbed by a sibling. Only the last row is a real regression signal.
//
//   | reverted                                                              | result                     |
//   |-----------------------------------------------------------------------|----------------------------|
//   | `NULLISH_SEGMENT` check dropped from `ensureDirectories`               | unit case **RED**          |
//   | `tmpRoot()` → the shipped `path.join(os.tmpdir(), app)`                 | `temp-undefined` **RED**   |
//   | `firstNonEmpty`'s `"undefined"` filter + `isSuspect`'s segment check    | green — `isSuspect` still  |
//   |                                                                         | rejects the RELATIVE       |
//   |                                                                         | `"undefined"` and relocates|
//   | all of the above **plus** `isSuspect → false` and `baseDir` returning   | **5 of 5 RED** (both the   |
//   | `path.join(String(home), …)`, i.e. the pre-f232051a0 shape              | unit case and all four     |
//   |                                                                         | fixture scenarios)         |
describe("design principle 11: a stringified `undefined` never becomes a directory", () => {
  const NULLISH_SEGMENT = /(?:^|[\\/])(?:undefined|null)(?:[\\/]|$)/

  test("this instance's own paths carry no `undefined`/`null` segment", () => {
    // The cheapest possible version of "look at where the bytes go". On the machine that produced
    // the stray, `Global.Path.data` WAS `C:\Users\nangl\undefined\novaclaw` and no test noticed.
    const live = {
      data: Global.Path.data,
      cache: Global.Path.cache,
      config: Global.Path.config,
      state: Global.Path.state,
      log: Global.Path.log,
      repos: Global.Path.repos,
      bin: Global.Path.bin,
      tmp: Global.Path.tmp,
      scratch: Scratch.root(),
    }
    expect(Object.entries(live).filter(([, v]) => NULLISH_SEGMENT.test(v))).toEqual([])
    // …and every one of them absolute, because a relative instance path writes into whatever folder
    // the process happens to be in — which for this product is the user's own project.
    expect(Object.entries(live).filter(([, v]) => !path.isAbsolute(v))).toEqual([])
  })

  test("`ensureDirectories` refuses such a path instead of creating it", async () => {
    await using dir = await tmpdir()
    // The control first: the raw syscall this guard wraps is perfectly happy to make the directory.
    const control = path.join(dir.path, "control", "undefined", "novaclaw")
    mkdirSync(control, { recursive: true })
    expect(existsSync(control)).toBe(true)

    const poisoned = [
      path.join(dir.path, "guarded", String(undefined), "novaclaw"),
      path.join(dir.path, "guarded", String(null), "novaclaw"),
      path.join(dir.path, "guarded", "novaclaw", String(undefined)),
    ]
    const healthy = path.join(dir.path, "guarded", "real")

    const faults = Global.ensureDirectories([...poisoned, healthy])

    // Each poisoned path is reported by name — a fault a repair can act on, not a silent skip.
    expect(faults.map((fault) => fault.directory)).toEqual(poisoned)
    expect(faults.every((fault) => /nullish/i.test(fault.message))).toBe(true)
    // Nothing was created for them…
    expect(poisoned.filter((entry) => existsSync(entry))).toEqual([])
    expect(existsSync(path.join(dir.path, "guarded", "undefined"))).toBe(false)
    expect(existsSync(path.join(dir.path, "guarded", "null"))).toBe(false)
    // …and one bad entry does not stop the rest, which is this function's whole contract.
    expect(existsSync(healthy)).toBe(true)
  })

  // Every poison the resolver can actually be handed, driven end to end in its own process, with the
  // disk inspected afterwards. `Global` memoises per process, so a subprocess is the only honest
  // instrument — see `fixture/write-scope-poison.ts`.
  const FIXTURE = path.join(import.meta.dir, "fixture", "write-scope-poison.ts")
  const SCENARIOS = ["xdg-literal-undefined", "empty-homedir", "novaclaw-home-undefined", "temp-undefined"] as const

  for (const scenario of SCENARIOS)
    test(`the real resolver under \`${scenario}\` writes nothing named "undefined"`, async () => {
      await using dir = await tmpdir()
      const child = Bun.spawn([process.execPath, FIXTURE, scenario], {
        cwd: dir.path,
        env: { ...process.env, POISON_SANDBOX: dir.path, NODE_ENV: "" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const line = stdout.trim().split("\n").at(-1) ?? ""
      if (!line.startsWith("{"))
        throw new Error(`the poison fixture printed no report (exit ${exitCode}).\n${stdout}\n${stderr}`)
      const report = JSON.parse(line) as {
        twin: { target: string; created: boolean; strays: string[] }
        resolved: Record<string, string>
        strays: string[]
      }

      // ⚠️ THE CONTROL. The pre-fix expression, same process, same poison: it must still produce a
      // directory literally named `undefined`. Without this the case below passes for free the day
      // the poison stops biting.
      expect(NULLISH_SEGMENT.test(report.twin.target)).toBe(true)
      expect(report.twin.created).toBe(true)
      expect(report.twin.strays.length).toBeGreaterThan(0)

      // The claim: nothing the guarded resolver produced carries the segment…
      expect(Object.entries(report.resolved).filter(([, v]) => NULLISH_SEGMENT.test(v))).toEqual([])
      expect(Object.entries(report.resolved).filter(([, v]) => !path.isAbsolute(v))).toEqual([])
      // …and nothing named `undefined` exists anywhere it could reach on disk. This is the assertion
      // that would have caught the original: it looks OUTSIDE the tree, at the bytes.
      expect(report.strays).toEqual([])
    })
})
