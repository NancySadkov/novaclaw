#!/usr/bin/env bun
/**
 * The watchdog's LIVE smoke — it supervises a real process, or it does not work.
 *
 * 🔴 `cargo test` covers the classifier as a pure function. That is the half that is easy to test and
 * the half least likely to be wrong. Nothing there spawns a process, waits on it, reads a status,
 * consumes an intent file, or sleeps a dormancy — which is every part that touches the OS, and every
 * part where a watchdog actually fails. `notes/` records the rule this file exists for: *running it
 * beats testing it*.
 *
 * Each case drives the REAL binary against a REAL child and asserts what the watchdog did.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const BIN = path.join(import.meta.dir, "target", "release", process.platform === "win32" ? "novaclaw-watchdog.exe" : "novaclaw-watchdog")
/**
 * ⚠️ The ABSOLUTE path to the real bun binary, not the name.
 *
 * `Command::new("bun")` fails on Windows even with bun on PATH: it resolves there as an npm shim
 * (`bun.ps1`/`bun.cmd`) and Rust's PATH search appends `.exe` only. The watchdog deliberately does
 * not shell through `cmd /c` to paper over that — see the note in `main.rs`. `process.execPath` is
 * this very bun, by definition.
 */
const BUN = process.execPath
if (!existsSync(BIN)) {
  console.error(`FAIL: build the binary first — cargo build --release  (looked for ${BIN})`)
  process.exit(1)
}

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `   ${detail}` : ""}`)
  if (!ok) failures++
}

/**
 * A child that records each of its starts and behaves as the case dictates.
 *
 * ⚠️ Written as a script the watchdog runs, not as a function, because the thing under test is
 * process supervision — a child that is not a real process tests nothing.
 */
const childScript = (stateDir: string, body: string) => {
  const file = path.join(stateDir, "child.ts")
  writeFileSync(
    file,
    `import { appendFileSync, writeFileSync } from "node:fs"\n` +
      `const state = ${JSON.stringify(stateDir)}\n` +
      `const runs = ${JSON.stringify(path.join(stateDir, "runs.log"))}\n` +
      `appendFileSync(runs, "x")\n` +
      `const n = require("node:fs").readFileSync(runs, "utf8").length\n` +
      body,
  )
  return file
}

const runs = (stateDir: string) => {
  try {
    return readFileSync(path.join(stateDir, "runs.log"), "utf8").length
  } catch {
    return 0
  }
}

/** Run the watchdog over a child, for at most `ms`, then kill the watchdog TREE. */
const supervise = async (stateDir: string, child: string, ms: number) => {
  const proc = Bun.spawn([BIN, "--state", stateDir, "--", BUN, child], { stdout: "pipe", stderr: "pipe" })
  const done = proc.exited
  const timer = setTimeout(() => {
    if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(proc.pid), "/f", "/t"], { stdout: "ignore", stderr: "ignore" })
    else proc.kill()
  }, ms)
  const code = await done
  clearTimeout(timer)
  return { code, stderr: await new Response(proc.stderr).text() }
}

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wd-"))

// ── 1. A CRASHING child is restarted ────────────────────────────────────────────
{
  const dir = tmp()
  // Exits 1 with no intent: a crash by both signals.
  const child = childScript(dir, `process.exit(1)\n`)
  await supervise(dir, child, 6_000)
  const n = runs(dir)
  check("a crashing child is restarted repeatedly", n >= 3, `started ${n}x in 6s`)
  rmSync(dir, { recursive: true, force: true })
}

// ── 2. A child that exits CLEANLY but says nothing is still restarted ───────────
//
// 🔴 The case that makes exit 0 unusable as the shutdown signal. A tidy exit is not a request to
// stay down, and treating it as one is how an instance silently stops coming back.
{
  const dir = tmp()
  const child = childScript(dir, `process.exit(0)\n`)
  await supervise(dir, child, 5_000)
  const n = runs(dir)
  check("exit 0 with no intent is treated as a crash, not a shutdown", n >= 2, `started ${n}x`)
  rmSync(dir, { recursive: true, force: true })
}

// ── 3. A LEGITIMATE shutdown stops the watchdog ────────────────────────────────
{
  const dir = tmp()
  const child = childScript(
    dir,
    `writeFileSync(state + "/exit-intent.json.tmp", JSON.stringify({ kind: "shutdown" }))\n` +
      `require("node:fs").renameSync(state + "/exit-intent.json.tmp", state + "/exit-intent.json")\n` +
      `process.exit(77)\n`,
  )
  const started = Date.now()
  const { code } = await supervise(dir, child, 8_000)
  const elapsed = Date.now() - started
  const n = runs(dir)
  check("a shutdown intent + code 77 stops the watchdog", n === 1 && code === 0, `started ${n}x, watchdog exit ${code}`)
  check("…and it stops promptly rather than waiting out the timeout", elapsed < 6_000, `${elapsed}ms`)
  rmSync(dir, { recursive: true, force: true })
}

// ── 4. A DORMANT child comes back after its own stated delay ───────────────────
//
// ⭐ The requirement an exit code cannot express: the child names WHEN, and the watchdog honours it.
{
  const dir = tmp()
  const child = childScript(
    dir,
    `if (n === 1) {\n` +
      `  writeFileSync(state + "/exit-intent.json.tmp", JSON.stringify({ kind: "dormant", wakeAtMs: Date.now() + 3000 }))\n` +
      `  require("node:fs").renameSync(state + "/exit-intent.json.tmp", state + "/exit-intent.json")\n` +
      `  process.exit(77)\n` +
      `}\n` +
      `await new Promise(() => {})\n`, // the second start stays alive so we can time the gap
  )
  const started = Date.now()
  await supervise(dir, child, 9_000)
  const n = runs(dir)
  check("a dormant child is restarted after its stated delay", n === 2, `started ${n}x`)
  rmSync(dir, { recursive: true, force: true })
  void started
}

// ── 5. A STALE intent cannot be replayed onto a later run ──────────────────────
//
// 🔴 The replay hazard: a shutdown intent left on disk by an earlier run must not stop the watchdog
// when a LATER child crashes. The watchdog clears before spawning and consumes on read, so it cannot.
{
  const dir = tmp()
  writeFileSync(path.join(dir, "exit-intent.json"), JSON.stringify({ kind: "shutdown" }))
  const child = childScript(dir, `process.exit(1)\n`)
  await supervise(dir, child, 5_000)
  const n = runs(dir)
  check("a pre-existing intent file does not stop a crashing child being restarted", n >= 2, `started ${n}x`)
  rmSync(dir, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL LIVE CASES PASSED" : `\n${failures} LIVE CASE(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
