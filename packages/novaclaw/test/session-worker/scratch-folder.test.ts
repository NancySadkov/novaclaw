import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { scratchDirectory, workingDirectory } from "../../src/session-worker/scratch-folder"

/**
 * Ruling 1 for the lost-working-folder recovery (``, owner 2026-08-07).
 *
 * Measured before the fix: a session whose folder vanished could not start its worker and was
 * ISOLATED, and the prompt that triggered it was accepted with `200` then stranded — `promoted_seq`
 * NULL with no `user` row, so the user's words were nowhere they could be seen.
 */
const sessionID = (suffix: string) => SessionSchema.ID.make(`ses_${suffix.padEnd(24, "0")}`)

describe("workingDirectory", () => {
  test("returns the session's own folder unchanged when it is there", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-scratch-ok-"))
    try {
      // Identity, not merely equality: callers compare against the input to decide whether the
      // session moved, so a normalized-but-equal path would make every turn look like a relocation.
      expect(String(workingDirectory(sessionID("keep"), directory))).toBe(directory)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("🔴 substitutes a real, writable scratch folder when the session's folder is gone", () => {
    const id = sessionID("gone")
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-scratch-gone-"))
    fs.rmSync(directory, { recursive: true, force: true })
    fs.rmSync(scratchDirectory(id), { recursive: true, force: true })

    const resolved = String(workingDirectory(id, directory))
    expect(resolved).not.toBe(directory)
    // It must EXIST and be writable — returning a path the worker then fails to spawn into would
    // just move the failure, which is the whole thing this is meant to prevent.
    expect(fs.existsSync(resolved)).toBe(true)
    fs.writeFileSync(path.join(resolved, "probe.txt"), "ok")
    expect(fs.readFileSync(path.join(resolved, "probe.txt"), "utf8")).toBe("ok")
  })

  test("🔴 the same session returns to the SAME scratch folder, keeping what it wrote", () => {
    // ⚠️ The property that makes this recovery rather than amnesia. A fresh directory per incident
    // would silently discard the agent's own work — the failure this mechanism exists to prevent,
    // one level up. A session can lose its folder more than once.
    const id = sessionID("stable")
    fs.rmSync(scratchDirectory(id), { recursive: true, force: true })

    const first = String(workingDirectory(id, path.join(os.tmpdir(), "novaclaw-absent-first")))
    fs.writeFileSync(path.join(first, "notes.md"), "work in progress")
    const second = String(workingDirectory(id, path.join(os.tmpdir(), "novaclaw-absent-second")))

    expect(second).toBe(first)
    expect(fs.readFileSync(path.join(second, "notes.md"), "utf8")).toBe("work in progress")
  })

  test("different sessions do not share a scratch folder", () => {
    expect(scratchDirectory(sessionID("aaa"))).not.toBe(scratchDirectory(sessionID("bbb")))
  })
})
