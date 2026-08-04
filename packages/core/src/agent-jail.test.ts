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

  // The full DEFAULT decision matrix (plan §2.1/§2.3, as amended by the owner 2026-07-30):
  // attended chains are untouched; unattended chains run confined under a backend enforcing BOTH
  // boundaries, and RAW where the host has none — the deny arm is now the safe-mode matrix below.
  const cases: Array<[SessionType, AgentJail.BackendInfo, AgentJail.BashDecision]> = [
    ["interactive", AgentJail.NO_BACKEND, "raw"],
    ["interactive", FULL, "raw"],
    ["sub-agent", AgentJail.NO_BACKEND, "raw"],
    // ⚠️ These four read "deny" until 2026-07-30. Changed deliberately: an unattended chain on a
    // backend-less host (every Windows host) may now run its shell. See agent-jail.ts's header.
    ["auto-prompting", AgentJail.NO_BACKEND, "raw"],
    ["goal-oriented", AgentJail.NO_BACKEND, "raw"],
    ["auto-prompting", FULL, "confined"],
    ["goal-oriented", FULL, "confined"],
    // A partial backend (FS view but no egress control) is NOT containment, so it does not reach
    // the confined arm — with safe mode off it falls through to the default like any other
    // backend-less host, and with safe mode on it denies (below).
    ["goal-oriented", FS_ONLY, "raw"],
  ]
  for (const [rootType, backend, expected] of cases)
    test(`decideBash(${rootType}, ${backend.kind}/fs:${backend.fs}/net:${backend.net}) = ${expected}`, () => {
      expect(AgentJail.decideBash({ rootType, backend })).toBe(expected)
    })

  // SAFE MODE — the same matrix with the switch ON. It is the exact pre-2026-07-30 behaviour, which
  // is what makes it a *restoration* rather than a fourth posture: every row here was the shipped
  // answer before the reversal.
  const safeCases: Array<[SessionType, AgentJail.BackendInfo, AgentJail.BashDecision]> = [
    // Attended is UNAFFECTED in both positions — safe mode is not a second attendance flag.
    ["interactive", AgentJail.NO_BACKEND, "raw"],
    ["interactive", FULL, "raw"],
    ["sub-agent", AgentJail.NO_BACKEND, "raw"],
    // Unattended: confined where the host can confine, refused where it cannot.
    ["auto-prompting", FULL, "confined"],
    ["goal-oriented", FULL, "confined"],
    ["auto-prompting", AgentJail.NO_BACKEND, "deny"],
    ["goal-oriented", AgentJail.NO_BACKEND, "deny"],
    ["goal-oriented", FS_ONLY, "deny"],
  ]
  for (const [rootType, backend, expected] of safeCases)
    test(`decideBash(${rootType}, ${backend.kind}/fs:${backend.fs}/net:${backend.net}, safeMode) = ${expected}`, () => {
      expect(AgentJail.decideBash({ rootType, backend, safeMode: true })).toBe(expected)
    })

  test("safeMode:false and an omitted safeMode are the SAME (default) answer, everywhere", () => {
    const roots: SessionType[] = ["interactive", "sub-agent", "auto-prompting", "goal-oriented"]
    for (const rootType of roots)
      for (const backend of [AgentJail.NO_BACKEND, FULL, FS_ONLY])
        expect(AgentJail.decideBash({ rootType, backend, safeMode: false })).toBe(
          AgentJail.decideBash({ rootType, backend }),
        )
  })

  test("safeMode can only ever REFUSE — it never turns a deny into a run", () => {
    // Exhaustive over the whole input space: for every combination, the safe-mode answer is never
    // more permissive than the default one. This is what makes the switch composable with the
    // narrowing keystone without a clamp of its own (config-resolve.ts §SAFE MODE).
    const rank: Record<AgentJail.BashDecision, number> = { deny: 0, confined: 1, raw: 2 }
    const roots: SessionType[] = ["interactive", "sub-agent", "auto-prompting", "goal-oriented"]
    for (const rootType of roots)
      for (const backend of [AgentJail.NO_BACKEND, FULL, FS_ONLY])
        for (const hostileInput of [true, false, undefined])
          expect(
            rank[AgentJail.decideBash({ rootType, backend, hostileInput, safeMode: true })],
            `safeMode LOOSENED ${rootType}/${backend.kind}/hostile:${hostileInput}`,
          ).toBeLessThanOrEqual(rank[AgentJail.decideBash({ rootType, backend, hostileInput })])
  })

  test("hostileInput is NOT governed by safe mode — an untrusted turn is contained either way", () => {
    // The owner's directive reversed the ATTENDANCE arm. The messenger-trust arm answers a
    // different adversary (untrusted text arriving as data) and AGENTS.md principle 9(c) still
    // binds, so turning safe mode off must not buy a stranger's turn the host.
    for (const safeMode of [true, false, undefined]) {
      expect(
        AgentJail.decideBash({ rootType: "interactive", backend: AgentJail.NO_BACKEND, hostileInput: true, safeMode }),
      ).toBe("deny")
      expect(
        AgentJail.decideBash({
          rootType: "goal-oriented",
          backend: AgentJail.NO_BACKEND,
          hostileInput: true,
          safeMode,
        }),
      ).toBe("deny")
      expect(AgentJail.decideBash({ rootType: "interactive", backend: FULL, hostileInput: true, safeMode })).toBe(
        "confined",
      )
    }
  })

  // messenger-plan §3.4: a client/audience-driven turn is unattended hostile input even on an
  // interactive root — so `hostileInput` flips an otherwise-raw interactive chain to the
  // unattended arm (confined under a backend, deny without one), while never RELAXING an already
  // unattended decision, and being a no-op when false.
  test("hostileInput treats an interactive turn as unattended (confine or deny)", () => {
    expect(AgentJail.decideBash({ rootType: "interactive", backend: AgentJail.NO_BACKEND, hostileInput: true })).toBe(
      "deny",
    )
    expect(AgentJail.decideBash({ rootType: "interactive", backend: FULL, hostileInput: true })).toBe("confined")
    expect(AgentJail.decideBash({ rootType: "sub-agent", backend: FS_ONLY, hostileInput: true })).toBe("deny")
    // false / omitted is a no-op — attended stays raw.
    expect(AgentJail.decideBash({ rootType: "interactive", backend: AgentJail.NO_BACKEND, hostileInput: false })).toBe(
      "raw",
    )
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

  // Ruling 2 — a refusal names ITSELF, and the right one. A user who ticked Safe mode and then read
  // "this platform has no sandbox backend yet" would conclude the product is broken.
  test("denyMessage names SAFE MODE and where to turn it off, without blaming the platform", () => {
    const safe = AgentJail.denyMessage("goal-oriented", false, true)
    expect(safe).toContain("Safe mode is ON")
    expect(safe).toContain("Tuning")
    expect(safe).not.toContain("untrusted messenger chat")
    // The three reasons must stay distinguishable — a shared prefix would defeat the point.
    expect(safe).not.toBe(AgentJail.denyMessage("goal-oriented"))
    expect(safe).not.toBe(AgentJail.denyMessage("goal-oriented", true))
    // Hostility WINS the wording: with both true the refusal would have happened anyway, so
    // naming safe mode would describe a cause that was not the operative one.
    expect(AgentJail.denyMessage("interactive", true, true)).toBe(AgentJail.denyMessage("interactive", true))
    // Every arm still teaches the same way forward (the tail `HostExec.DENY_ROUTING` mirrors).
    for (const text of [safe, AgentJail.denyMessage("goal-oriented"), AgentJail.denyMessage("interactive", true)])
      expect(text.endsWith("Do not retry the same command.")).toBe(true)
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
    for (const cmd of bypasses) expect(Wildcard.match(cmd, denyPattern)).toBe(false) // every one sails past the matcher
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
