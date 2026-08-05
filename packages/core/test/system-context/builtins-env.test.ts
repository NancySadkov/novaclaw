import { describe, expect, test } from "bun:test"
import { SystemContextBuiltIns } from "@novaclaw/core/system-context/builtins"

/**
 * The `<env>` block is prompt real estate on EVERY turn of EVERY session, so a line that carries no
 * information is not merely untidy — it is a standing tax, and a misleading one is worse than absent.
 * These pin the two lines that were removed and why (owner, 2026-08-05).
 */
describe("<env> workspace root", () => {
  test("a drive or filesystem root is NOT reported as the workspace root", () => {
    // "Workspace root folder: C:" is what `Project.resolve` falls back to for a directory in no
    // project. It tells the model nothing AND invites it to treat the whole drive as its workspace,
    // which principle 11 forbids — outside the session's folder we read, and nothing more.
    expect(SystemContextBuiltIns.isInformativeRoot("C:", "C:\Users\nancy\work")).toBe(false)
    expect(SystemContextBuiltIns.isInformativeRoot("C:\\", "C:\Users\nancy\work")).toBe(false)
    expect(SystemContextBuiltIns.isInformativeRoot("/", "/home/nancy/work")).toBe(false)
  })

  test("a root identical to the working directory is not repeated", () => {
    expect(SystemContextBuiltIns.isInformativeRoot("/home/nancy/work", "/home/nancy/work")).toBe(false)
  })

  test("a real project root above the working directory IS reported", () => {
    // The case the line exists for: the model is in a subdirectory and needs to know where the
    // project actually begins.
    expect(SystemContextBuiltIns.isInformativeRoot("/home/nancy/repo", "/home/nancy/repo/packages/core")).toBe(true)
    expect(SystemContextBuiltIns.isInformativeRoot("C:\repo", "C:\repo\packages\core")).toBe(true)
  })
})
