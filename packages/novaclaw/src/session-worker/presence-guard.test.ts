import { describe, expect, test } from "bun:test"
import path from "node:path"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { workingDirectory } from "./scratch-folder"
import { spawn } from "./supervisor"

/**
 * ─── a session's folder: gone, or merely unreadable? ────────────────────────────────────────────
 *
 * 🔴 Audited 2026-08-19. Both files below decided "is the user's project folder there?" with
 * `fs.existsSync`, which answers `false` for `EACCES`, `EPERM`, `ELOOP` and `EIO` **exactly as it does
 * for `ENOENT`**. Two things were then done on that one value, and both are claims:
 *
 *  1. `scratch-folder.ts` **relocated a live session** to a scratch directory and durably recorded
 *     `missing_working_folder`, which the app renders as *"This chat's folder is missing — it was
 *     working in {folder}, which is no longer there."*
 *  2. `supervisor.ts` refused the spawn with *"Session working folder no longer exists … until it is
 *     restored"* — an imperative to repair something that was very likely still sitting right there.
 *
 * A project folder that has lost read permission, or lives on a share that is erroring rather than
 * unmounted, is the ordinary way to reach that. Both now go through `@novaclaw/core/presence`.
 *
 * ⚠️ **The unreadable path here is a real one, not a stub.** A NUL byte is rejected by the syscall
 * wrapper before any lookup happens, so the filesystem never says anything about existence — the same
 * state `EACCES` leaves us in, reproducible on every platform without having to manufacture an ACL.
 * `existsSync` returns a flat `false` for it, which is precisely the collapse under test.
 */

const UNREADABLE = "C:/session\u0000folder"
const HERE = path.resolve(import.meta.dir)
const id = SessionSchema.ID.make("ses_presence_guard_probe")

describe("workingDirectory — only a CONFIRMED absence may move a live session", () => {
  test("a folder that is there is returned unchanged", () => {
    expect(String(workingDirectory(id, HERE))).toBe(HERE)
  })

  test("⭐ a folder we could not READ is returned unchanged — the session is NOT relocated", () => {
    // Before the fix this fell into the relocation branch, created a scratch directory and detached the
    // session from the user's real work on the strength of a stat that never ran.
    expect(String(workingDirectory(id, UNREADABLE))).toBe(UNREADABLE)
  })
})

describe("spawn — the refusal names what we actually observed", () => {
  const lease = { sessionID: id, attemptID: "exe_presence_guard", generation: 1, ownerID: "host-test" }
  const messageFor = (directory: string): string => {
    try {
      // The guard runs before anything is spawned, so this never reaches `childProcess.spawn`.
      spawn({ command: [process.execPath, "-e", ""], lease, directory, force: false })
      return "(it did not refuse)"
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  test("a folder that is genuinely gone still reads “no longer exists”", () => {
    // The one-directional guarantee: an honest absence is unchanged, so nothing here can hide a real
    // missing folder behind an excuse about the instrument.
    const message = messageFor(path.join(HERE, "no-such-folder-4b1e7c"))
    expect(message).toContain("no longer exists")
  })

  test("⭐ a folder we could not READ says so, names the errno, and claims nothing", () => {
    const message = messageFor(UNREADABLE)
    expect(message).toContain("I could not read")
    expect(message).toContain("I cannot tell whether it is still there")
    // The teach-the-way-forward half: what a person can actually go and do about it.
    expect(message).toContain("permissions")
    // The assertion the whole change is about.
    for (const forbidden of ["no longer exists", "is missing", "restored"])
      expect({ forbidden, present: message.includes(forbidden) }).toEqual({ forbidden, present: false })
  })
})
