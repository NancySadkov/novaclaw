import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentJail } from "../src/agent-jail"
import { HostExec } from "../src/host-exec"
import { JhProcessRunner } from "../src/jh/process-runner"

// The ONE host-execution gate (v0.2.0 ruling 6). Two rules are pinned here, because both used to be
// re-derived per call site and both drifted:
//   · CONFINEMENT — AgentJail.decideBash, and a bwrap argv when confined (now argv-shaped, so
//     `<runtime> -e <program>` is expressible and not only `<shell> -c <command>`);
//   · CREDENTIALS — the operator's environment reaches a child only when a HUMAN approved THAT
//     command. Strict used to hand `{ ...process.env }` (provider keys, peer tokens) to every
//     model-authored command it ran.

const FULL: AgentJail.BackendInfo = { kind: "namespaces", fs: true, net: true }
const NONE = AgentJail.NO_BACKEND

const SERVE_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/nancy",
  OPENAI_API_KEY: "sk-live-xyz",
  NOVACLAW_INSTANCE_SPARK_TOKEN: "peer-secret",
  SOME_OPERATOR_EXPORT: "x",
}

const shellShape = (command = "make") =>
  ({ kind: "shell-command", shell: "/bin/bash", command }) as const

const base = {
  cwd: "/home/nancy/proj",
  worktree: "/home/nancy/proj",
  processEnv: SERVE_ENV,
  platform: "linux" as NodeJS.Platform,
}

describe("HostExec.argvOf — the gate is not `-c`-shaped", () => {
  test("a shell command becomes `<shell> -c <command>`", () => {
    expect(HostExec.argvOf({ kind: "shell-command", shell: "/bin/bash", command: "echo hi" })).toEqual([
      "/bin/bash",
      "-c",
      "echo hi",
    ])
  })
  test("a runtime eval becomes `<runtime> -e <program>` — the shape wrapArgs could never express", () => {
    expect(HostExec.argvOf({ kind: "runtime-eval", runtime: "/usr/bin/node", program: "1+1" })).toEqual([
      "/usr/bin/node",
      "-e",
      "1+1",
    ])
  })
})

describe("HostExec.decide", () => {
  test("declared attendance is exactly AgentJail.decideBash", () => {
    expect(HostExec.decide({ rootType: "interactive", backend: NONE })).toBe("raw")
    expect(HostExec.decide({ rootType: "goal-oriented", backend: FULL })).toBe("confined")
    expect(HostExec.decide({ rootType: "auto-prompting", backend: NONE })).toBe("deny")
    expect(HostExec.decide({ rootType: "interactive", backend: FULL, hostileInput: true })).toBe("confined")
  })

  test("an UNDECLARED root runs raw — the gate never invents an attendance it was not told", () => {
    expect(HostExec.decide({ backend: NONE })).toBe("raw")
    expect(HostExec.decide({ backend: FULL })).toBe("raw")
  })

  test("…but an undeclared HOSTILE turn still takes the unattended arm", () => {
    expect(HostExec.decide({ backend: FULL, hostileInput: true })).toBe("confined")
    expect(HostExec.decide({ backend: NONE, hostileInput: true })).toBe("deny")
  })
})

describe("HostExec.curatedEnv", () => {
  test("no secret survives, on any platform", () => {
    for (const platform of ["linux", "win32", "darwin"] as NodeJS.Platform[]) {
      const env = HostExec.curatedEnv(SERVE_ENV, platform)
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.NOVACLAW_INSTANCE_SPARK_TOKEN).toBeUndefined()
      expect(env.SOME_OPERATOR_EXPORT).toBeUndefined()
      expect(env.PATH).toBe("/usr/bin:/bin")
    }
  })

  test("off Windows it is EXACTLY AgentJail's P3 allowlist — the confined path is unchanged", () => {
    expect(HostExec.curatedEnv(SERVE_ENV, "linux")).toEqual(AgentJail.unattendedChildEnv(SERVE_ENV))
  })

  test("on Windows the functional non-secret keys come along (a child without SystemRoot is broken)", () => {
    const win = {
      Path: "C:\\bin",
      PATH: "C:\\bin",
      SystemRoot: "C:\\WINDOWS",
      TEMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\nancy",
      ComSpec: "C:\\WINDOWS\\system32\\cmd.exe",
      ANTHROPIC_API_KEY: "sk-should-not-survive",
    }
    const env = HostExec.curatedEnv(win, "win32")
    // matched case-insensitively, handed over in the platform's own casing
    expect(env.SystemRoot).toBe("C:\\WINDOWS")
    expect(env.TEMP).toBe("C:\\Temp")
    expect(env.USERPROFILE).toBe("C:\\Users\\nancy")
    expect(env.ComSpec).toBe("C:\\WINDOWS\\system32\\cmd.exe")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    // and they are win32-only, so the Linux bwrap path never sees them
    expect(HostExec.curatedEnv(win, "linux").SystemRoot).toBeUndefined()
  })
})

describe("HostExec.childEnv — the credential rule", () => {
  const credentials = { NOVACLAW_INSTANCE_SPARK_TOKEN: "peer-secret" }

  test("per-command consent + raw: the child inherits, and carries the peer tokens", () => {
    const env = HostExec.childEnv({
      consent: "per-command",
      rootType: "interactive",
      backend: NONE,
      credentials,
      egress: { HTTPS_PROXY: "http://127.0.0.1:9" },
      processEnv: SERVE_ENV,
      platform: "linux",
    })
    expect(env.inherit).toBe(true)
    expect(env.vars.NOVACLAW_INSTANCE_SPARK_TOKEN).toBe("peer-secret")
    expect(env.vars.HTTPS_PROXY).toBe("http://127.0.0.1:9")
  })

  test("per-command consent + CONFINED: no inheritance, credentials dropped", () => {
    const env = HostExec.childEnv({
      consent: "per-command",
      rootType: "goal-oriented",
      backend: FULL,
      credentials,
      processEnv: SERVE_ENV,
      platform: "linux",
    })
    expect(env.inherit).toBe(false)
    expect(env.vars.NOVACLAW_INSTANCE_SPARK_TOKEN).toBeUndefined()
    expect(env.vars.OPENAI_API_KEY).toBeUndefined()
    expect(env.vars.PATH).toBe("/usr/bin:/bin")
  })

  test("NO consent (the jh runner, the js sandbox) is uncredentialed even when it runs RAW", () => {
    const env = HostExec.childEnv({
      consent: "none",
      rootType: "interactive",
      backend: NONE,
      credentials,
      overlay: { PATH: "/mingw64/bin:/usr/bin:/bin" },
      processEnv: SERVE_ENV,
      platform: "linux",
    })
    expect(env.inherit).toBe(false)
    expect(env.vars.NOVACLAW_INSTANCE_SPARK_TOKEN).toBeUndefined()
    expect(env.vars.OPENAI_API_KEY).toBeUndefined()
    expect(env.vars.SOME_OPERATOR_EXPORT).toBeUndefined()
    // the functional overlay still wins over the curated base
    expect(env.vars.PATH).toBe("/mingw64/bin:/usr/bin:/bin")
  })

  test("an UNDECLARED caller is uncredentialed too — the half of the gate that needs no declaration", () => {
    const env = HostExec.childEnv({ consent: "none", credentials, processEnv: SERVE_ENV, platform: "linux" })
    expect(env.inherit).toBe(false)
    expect(env.vars.NOVACLAW_INSTANCE_SPARK_TOKEN).toBeUndefined()
    expect(env.vars.OPENAI_API_KEY).toBeUndefined()
  })
})

describe("HostExec.plan", () => {
  test("raw shell command: run the STRING through the shell option (cmd.exe is not `-c`)", () => {
    const p = HostExec.plan({ ...base, shape: shellShape(), consent: "per-command", rootType: "interactive", backend: NONE })
    expect(p.via).toBe("shell")
    if (p.via !== "shell") throw new Error("unreachable")
    expect(p.shell).toBe("/bin/bash")
    expect(p.command).toBe("make")
    expect(p.env.inherit).toBe(true)
  })

  test("confined shell command: exec bwrap, shell as an ARGV element, curated env, no inheritance", () => {
    const p = HostExec.plan({
      ...base,
      shape: shellShape("rm -rf /"),
      consent: "per-command",
      rootType: "goal-oriented",
      backend: FULL,
      credentials: { NOVACLAW_INSTANCE_SPARK_TOKEN: "peer-secret" },
    })
    expect(p.via).toBe("exec")
    if (p.via !== "exec") throw new Error("unreachable")
    expect(p.file).toBe("bwrap")
    expect(p.args).toContain("--unshare-all")
    expect(p.args.slice(p.args.indexOf("--") + 1)).toEqual(["/bin/bash", "-c", "rm -rf /"])
    expect(p.args.slice(p.args.indexOf("--bind"), p.args.indexOf("--bind") + 3)).toEqual([
      "--bind",
      "/home/nancy/proj",
      "/home/nancy/proj",
    ])
    expect(p.env.inherit).toBe(false)
    expect(p.env.vars.NOVACLAW_INSTANCE_SPARK_TOKEN).toBeUndefined()
  })

  test("confined RUNTIME EVAL: the sandbox tail is `-e`, not `-c` (the js shape)", () => {
    const p = HostExec.plan({
      ...base,
      shape: { kind: "runtime-eval", runtime: "/usr/bin/node", program: "console.log(1)" },
      consent: "none",
      rootType: "goal-oriented",
      backend: FULL,
    })
    if (p.via !== "exec") throw new Error("expected an exec plan")
    expect(p.file).toBe("bwrap")
    expect(p.args.slice(p.args.indexOf("--") + 1)).toEqual(["/usr/bin/node", "-e", "console.log(1)"])
  })

  test("raw runtime eval execs the runtime directly — no shell in the middle", () => {
    const p = HostExec.plan({
      ...base,
      shape: { kind: "runtime-eval", runtime: "/usr/bin/node", program: "1+1" },
      consent: "none",
      rootType: "interactive",
      backend: NONE,
    })
    if (p.via !== "exec") throw new Error("expected an exec plan")
    expect(p.file).toBe("/usr/bin/node")
    expect(p.args).toEqual(["-e", "1+1"])
    expect(p.env.inherit).toBe(false)
  })

  test("deny: no process is described at all, only the routing text", () => {
    const p = HostExec.plan({ ...base, shape: shellShape(), consent: "per-command", rootType: "auto-prompting", backend: NONE })
    expect(p.via).toBe("none")
    if (p.via !== "none") throw new Error("unreachable")
    expect(p.message).toContain("auto-prompting")
    expect(p.message).toContain("read/edit/write/create/glob/grep")
  })
})

describe("HostExec.spawnPlan — the jh-runner wire shape", () => {
  // The structural pin: §0.7.2 forbids `src/jh/**` from importing the gate, so the runner declares
  // the plan shape locally. This assignment is the mechanical check that the two cannot drift — it
  // is exactly what `session/runner/strict.ts` does, and a drift is a type error here.
  const asRunnerPlan = (p: JhProcessRunner.SpawnPlan): JhProcessRunner.SpawnPlan => p

  test("a raw shell plan carries the shell and the env stance", () => {
    const p = asRunnerPlan(
      HostExec.spawnPlan({ ...base, shape: shellShape(), consent: "none", rootType: "interactive", backend: NONE }),
    )
    expect(p.shell).toBe("/bin/bash")
    expect(p.file).toBeUndefined()
    expect(p.inherit).toBe(false)
    expect(p.denied).toBeUndefined()
  })

  test("a confined plan carries the bwrap argv and NO shell option", () => {
    const p = asRunnerPlan(
      HostExec.spawnPlan({ ...base, shape: shellShape(), consent: "none", rootType: "goal-oriented", backend: FULL }),
    )
    expect(p.file).toBe("bwrap")
    expect(p.shell).toBeUndefined()
    const args = p.args ?? []
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["/bin/bash", "-c", "make"])
  })

  test("a denied plan says so instead of describing a process", () => {
    const p = asRunnerPlan(
      HostExec.spawnPlan({ ...base, shape: shellShape(), consent: "none", rootType: "goal-oriented", backend: NONE }),
    )
    expect(p.denied).toContain("goal-oriented")
    expect(p.file).toBeUndefined()
    expect(p.shell).toBeUndefined()
  })
})

describe("HostExec.chainHasHostileBinding — one walk, two callers", () => {
  // It used to be a closure inside `tool/bash.ts`'s layer, so the Strict runner could not ask it
  // without a second copy. These pin the behaviour the two call sites now share.
  const chain = (
    parents: Record<string, string | undefined>,
    bindings: Record<string, ReadonlyArray<HostExec.ChainBinding>>,
  ) => ({
    bindingsForSession: (id: string) => Effect.succeed(bindings[id] ?? []),
    parentOf: (id: string) => Effect.succeed(parents[id]),
  })
  const run = (id: string, lookup: HostExec.ChainLookup) =>
    Effect.runSync(HostExec.chainHasHostileBinding(id, lookup))

  test("an active client/audience binding ON AN ANCESTOR makes the turn hostile", () => {
    const lookup = chain({ worker: "bound", bound: undefined }, { bound: [{ status: "active", trust: "client" }] })
    expect(run("worker", lookup)).toBe(true)
    expect(run("bound", lookup)).toBe(true)
  })

  test("audience trust counts too; operator trust and inactive bindings do not", () => {
    expect(run("s", chain({ s: undefined }, { s: [{ status: "active", trust: "audience" }] }))).toBe(true)
    expect(run("s", chain({ s: undefined }, { s: [{ status: "active", trust: "operator" }] }))).toBe(false)
    expect(run("s", chain({ s: undefined }, { s: [{ status: "paused", trust: "client" }] }))).toBe(false)
    expect(run("s", chain({ s: undefined }, {}))).toBe(false)
  })

  test("a parent CYCLE terminates instead of walking forever", () => {
    expect(run("a", chain({ a: "b", b: "a" }, {}))).toBe(false)
  })

  test("a failing lookup ends that step instead of crashing the turn", () => {
    const failing: HostExec.ChainLookup = {
      bindingsForSession: () => Effect.fail(new Error("messenger lookup failed")),
      parentOf: () => Effect.fail(new Error("session row gone")),
    }
    expect(run("s", failing)).toBe(false)
    // …and a failure on the CHILD must not hide a hostile ANCESTOR
    const childFails: HostExec.ChainLookup = {
      bindingsForSession: (id) =>
        id === "child"
          ? Effect.fail(new Error("transient"))
          : Effect.succeed<ReadonlyArray<HostExec.ChainBinding>>([{ status: "active", trust: "client" }]),
      parentOf: (id) => Effect.succeed(id === "child" ? "bound" : undefined),
    }
    expect(run("child", childFails)).toBe(true)
  })

  test("the answer feeds `decide` — a hostile turn on a backend-less host is DENIED", () => {
    const hostile = run("s", chain({ s: undefined }, { s: [{ status: "active", trust: "client" }] }))
    expect(HostExec.decide({ rootType: "interactive", backend: NONE, hostileInput: hostile })).toBe("deny")
    expect(HostExec.decide({ rootType: "interactive", backend: FULL, hostileInput: hostile })).toBe("confined")
    // negative control: the same interactive root with no binding runs raw
    const clean = run("s", chain({ s: undefined }, {}))
    expect(HostExec.decide({ rootType: "interactive", backend: NONE, hostileInput: clean })).toBe("raw")
  })
})

describe("HostExec.resolveShell", () => {
  test("config.shell wins; otherwise the agent default (the COMSPEC divergence, closed)", () => {
    expect(HostExec.resolveShell("/opt/homebrew/bin/fish")).toBe("/opt/homebrew/bin/fish")
    expect(HostExec.resolveShell(undefined)).toBe(HostExec.resolveShell(undefined))
    expect(typeof HostExec.resolveShell(undefined)).toBe("string")
  })
})
