import { describe, expect, test } from "bun:test"
import { ProjectGrounding } from "@novaclaw/core/session/runner/project-grounding"

/**
 * Project grounding now rides a cadence-gated provider-only horizon rather than the epoch baseline.
 * This helper still pins the distinction between a useful project root and a filesystem fallback.
 */
describe("<env> workspace root", () => {
  test("a drive or filesystem root is NOT reported as the workspace root", () => {
    // "Workspace root folder: C:" is what `Project.resolve` falls back to for a directory in no
    // project. It tells the model nothing AND invites it to treat the whole drive as its workspace,
    // which principle 11 forbids — outside the session's folder we read, and nothing more.
    expect(ProjectGrounding.isInformativeRoot("C:", "C:\Users\nancy\work")).toBe(false)
    expect(ProjectGrounding.isInformativeRoot("C:\\", "C:\Users\nancy\work")).toBe(false)
    expect(ProjectGrounding.isInformativeRoot("/", "/home/nancy/work")).toBe(false)
  })

  test("a root identical to the working directory is not repeated", () => {
    expect(ProjectGrounding.isInformativeRoot("/home/nancy/work", "/home/nancy/work")).toBe(false)
  })

  test("a real project root above the working directory IS reported", () => {
    // The case the line exists for: the model is in a subdirectory and needs to know where the
    // project actually begins.
    expect(ProjectGrounding.isInformativeRoot("/home/nancy/repo", "/home/nancy/repo/packages/core")).toBe(true)
    expect(ProjectGrounding.isInformativeRoot("C:\repo", "C:\repo\packages\core")).toBe(true)
  })
})
