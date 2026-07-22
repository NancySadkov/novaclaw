import { describe, expect, test } from "bun:test"
import { AgentJail } from "./agent-jail"
import { Wildcard } from "./util/wildcard"
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

  // messenger-plan §3.4: a client/audience-driven turn is unattended hostile input even on an
  // interactive root — so `hostileInput` flips an otherwise-raw interactive chain to the
  // unattended arm (confined under a backend, deny without one), while never RELAXING an already
  // unattended decision, and being a no-op when false.
  test("hostileInput treats an interactive turn as unattended (confine or deny)", () => {
    expect(AgentJail.decideBash({ rootType: "interactive", backend: AgentJail.NO_BACKEND, hostileInput: true })).toBe("deny")
    expect(AgentJail.decideBash({ rootType: "interactive", backend: FULL, hostileInput: true })).toBe("confined")
    expect(AgentJail.decideBash({ rootType: "sub-agent", backend: FS_ONLY, hostileInput: true })).toBe("deny")
    // false / omitted is a no-op — attended stays raw.
    expect(AgentJail.decideBash({ rootType: "interactive", backend: AgentJail.NO_BACKEND, hostileInput: false })).toBe("raw")
    expect(AgentJail.decideBash({ rootType: "interactive", backend: AgentJail.NO_BACKEND })).toBe("raw")
    // An already-unattended root ignores the flag (still confined/deny by backend).
    expect(AgentJail.decideBash({ rootType: "goal-oriented", backend: FULL, hostileInput: true })).toBe("confined")
  })

  test("denyMessage names the hostile-chat reason, not the misleading interactive root type", () => {
    const hostile = AgentJail.denyMessage("interactive", true)
    expect(hostile).toContain("untrusted messenger chat")
    expect(hostile).not.toContain("interactive sessions")
    expect(AgentJail.denyMessage("goal-oriented")).toContain("goal-oriented sessions")
  })

  // The unit half of the GuardFall battery (P6): prove a string matcher is BLIND to exactly the
  // bypass classes the box contains — the reason confinement, not a blocklist, is the boundary.
  // The mechanism half (tests/agent-jail-guardfall-smoke.sh) proves the box catches them all.
  test("a command-string matcher is blind to every GuardFall bypass class (why the box is needed)", () => {
    // A defender's naive deny-pattern for the destructive act:
    const denyPattern = "rm -rf *"
    const bypasses = [
      "r''m -rf /data", // quote-splitting: the token "rm" never appears
      "rm${IFS}-rf${IFS}/data", // IFS: the space is a variable
      "$(echo rm) -rf /data", // command substitution: the verb is computed
      "find / -delete", // a different binary — no rm token at all
      "echo cm0gLXJmIC8= | base64 -d | sh", // base64 pipe: opaque until decoded
    ]
    for (const cmd of bypasses)
      expect(Wildcard.match(cmd, denyPattern)).toBe(false) // every one sails past the matcher
    // And the matcher only ever catches the LITERAL it was written for — proving it is a
    // convenience, not containment (util/wildcard.ts + permission.ts boundary notes).
    expect(Wildcard.match("rm -rf /data", denyPattern)).toBe(true)
  })

  test("unattendedChildEnv (P3): copies functional keys, DROPS every secret/instance var", () => {
    const env = AgentJail.unattendedChildEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/nancy",
      LANG: "en_US.UTF-8",
      // secrets + instance identity that must NOT survive into a confined command:
      NOVACLAW_INSTANCE_PEER_TOKEN: "s3cr3t",
      OPENAI_API_KEY: "sk-live-xyz",
      AWS_SECRET_ACCESS_KEY: "abc",
      NOVACLAW_SERVER_PASSWORD: "hunter2",
      SOME_RANDOM_EXPORT: "x",
    })
    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env.HOME).toBe("/home/nancy")
    expect(env.LANG).toBe("en_US.UTF-8")
    // the allowlist is exhaustive — nothing outside SAFE_ENV_KEYS leaks through:
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH"])
    expect(env.NOVACLAW_INSTANCE_PEER_TOKEN).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.NOVACLAW_SERVER_PASSWORD).toBeUndefined()
  })

  test("unattendedChildEnv: absent keys are omitted, not set to undefined", () => {
    const env = AgentJail.unattendedChildEnv({ PATH: "/bin" })
    expect(env).toEqual({ PATH: "/bin" })
    expect("HOME" in env).toBe(false)
  })

  test("deny routing text names the session type and the native-tool way forward", () => {
    const message = AgentJail.denyMessage("goal-oriented")
    expect(message).toContain("goal-oriented")
    expect(message).toContain("read/edit/write/create/glob/grep")
    expect(message).toContain("Do not retry")
  })
})
