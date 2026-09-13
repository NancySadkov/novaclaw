import { describe, expect, test } from "bun:test"
import { UnfinishedShells } from "./unfinished-shells"

describe("unfinished background shells", () => {
  test("names each job and gives both convergence actions", () => {
    const message = UnfinishedShells.exitNudge([
      { id: "job_build", sessionID: "ses_parent", command: "bun run build", startedAt: 1 },
      { id: "job_server", sessionID: "ses_parent", command: "bun run dev", startedAt: 2 },
    ])

    expect(message).toContain("2 background shell commands are still running")
    expect(message).toContain('{"job":"job_build","action":"wait","timeout":30000}')
    expect(message).toContain('{"job":"job_server","action":"stop"}')
    expect(message).toContain("then request exit again")
  })
})
