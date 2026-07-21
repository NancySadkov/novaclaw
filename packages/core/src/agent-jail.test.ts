import { describe, expect, test } from "bun:test"
import { AgentJail } from "./agent-jail"
import type { SessionType } from "./session/config-resolve"

const FULL: AgentJail.BackendInfo = { kind: "namespaces", fs: true, net: true }
const FS_ONLY: AgentJail.BackendInfo = { kind: "namespaces", fs: true, net: false }

describe("AgentJail", () => {
  test("detectBackend: non-linux is always none; linux requires the FULL bwrap probe to pass", () => {
    const pass = () => 0
    const fail = () => 1
    const absent = () => undefined
    expect(AgentJail.detectBackend("win32", pass)).toEqual(AgentJail.NO_BACKEND)
    expect(AgentJail.detectBackend("darwin", pass)).toEqual(AgentJail.NO_BACKEND)
    expect(AgentJail.detectBackend("linux", pass)).toEqual(AgentJail.NAMESPACES)
    // bwrap present but the sandbox cannot actually come up (the Ubuntu AppArmor userns
    // restriction with no bwrap profile — the measured Spark failure mode) => none.
    expect(AgentJail.detectBackend("linux", fail)).toEqual(AgentJail.NO_BACKEND)
    expect(AgentJail.detectBackend("linux", absent)).toEqual(AgentJail.NO_BACKEND)
  })

  test("the probe test command is the full sandbox shape (unshare-all), not a mere existence check", () => {
    expect(AgentJail.PROBE_ARGS).toContain("--unshare-all")
  })

  test("wrapArgs: both boundaries + load-bearing order + the exec tail", () => {
    const args = AgentJail.wrapArgs({
      worktree: "/home/nancy/proj",
      cwd: "/home/nancy/proj/sub",
      shell: "/bin/bash",
      command: "echo hi",
    })
    expect(args).toContain("--unshare-all") // deny-all egress
    expect(args).toContain("--die-with-parent")
    // The /home mask must precede the worktree bind so a worktree UNDER /home comes back writable.
    const homeMask = args.indexOf("/home")
    const worktreeBind = args.indexOf("/home/nancy/proj")
    expect(homeMask).toBeGreaterThan(-1)
    expect(worktreeBind).toBeGreaterThan(homeMask)
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["/bin/bash", "-c", "echo hi"])
    expect(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2)).toEqual([
      "--chdir",
      "/home/nancy/proj/sub",
    ])
  })

  test("probe on THIS host is cached and platform-honest", () => {
    AgentJail.resetProbeCache()
    const first = AgentJail.probe()
    if (process.platform !== "linux") expect(first).toEqual(AgentJail.NO_BACKEND)
    expect(AgentJail.probe()).toBe(first)
  })

  // The full decision matrix (plan §2.1/§2.3): attended chains are untouched; unattended
  // chains run confined only under a backend enforcing BOTH boundaries, else deny.
  const cases: Array<[SessionType, AgentJail.BackendInfo, AgentJail.BashDecision]> = [
    ["interactive", AgentJail.NO_BACKEND, "raw"],
    ["interactive", FULL, "raw"],
    ["sub-agent", AgentJail.NO_BACKEND, "raw"],
    ["auto-prompting", AgentJail.NO_BACKEND, "deny"],
    ["goal-oriented", AgentJail.NO_BACKEND, "deny"],
    ["auto-prompting", FULL, "confined"],
    ["goal-oriented", FULL, "confined"],
    // A partial backend (FS view but no egress control) is NOT containment — deny.
    ["goal-oriented", FS_ONLY, "deny"],
  ]
  for (const [rootType, backend, expected] of cases)
    test(`decideBash(${rootType}, ${backend.kind}/fs:${backend.fs}/net:${backend.net}) = ${expected}`, () => {
      expect(AgentJail.decideBash({ rootType, backend })).toBe(expected)
    })

  test("deny routing text names the session type and the native-tool way forward", () => {
    const message = AgentJail.denyMessage("goal-oriented")
    expect(message).toContain("goal-oriented")
    expect(message).toContain("read/edit/write/create/glob/grep")
    expect(message).toContain("Do not retry")
  })
})
