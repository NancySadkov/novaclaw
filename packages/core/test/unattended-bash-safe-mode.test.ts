import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { AgentJail } from "@novaclaw/core/agent-jail"
import { HostExec } from "@novaclaw/core/host-exec"
import {
  EFFECTIVE_CONFIG_DEFAULTS,
  MODE_RULES,
  SESSION_CONFIG_FIELDS,
  resolveConfig,
  type PermissionMode,
} from "@novaclaw/core/session/config-resolve"
import { SystemCompose } from "@novaclaw/core/session/runner/system-compose"

/**
 * The owner's 2026-07-30 directive, mechanically (ruling 1 — an invariant whose violation would
 * compile green ships with a check in the same change):
 *
 *   "unattended bash should be allowed by default, unless the user have enabled safe mode in
 *    tuning. Otherwise the model wont be unable to do any useful work. Yet the model should be
 *    instructed by a non-YOLO mode system that it should not modify any files outside of the
 *    project's folder."
 *
 * Three claims, three sections below. The pure-policy matrix lives beside the policy
 * (`src/agent-jail.test.ts`); this file proves the claims END TO END — through the ruling-6 gate
 * that `tool/bash.ts` and the Strict runner actually call, and through the composition the runner
 * actually feeds. The two source assertions at the bottom exist because the wiring is the half that
 * compiles green when it goes missing: a `safeMode` nobody passes and a `projectScope` nobody
 * composes are both perfectly type-correct and completely inert.
 */

const NONE = AgentJail.NO_BACKEND
const FULL: AgentJail.BackendInfo = { kind: "namespaces", fs: true, net: true }
const UNATTENDED = ["auto-prompting", "goal-oriented"] as const
const ATTENDED = ["interactive", "sub-agent"] as const
const ALL_MODES: PermissionMode[] = ["plan", "ask", "surgical", "bypass", "yolo"]

const coreSrc = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "src")
const source = (relative: string) => readFileSync(path.join(coreSrc, relative), "utf8")

/**
 * Assert a source shape WITHOUT putting the file in the failure message. `expect(text).toContain(…)`
 * on a 2,000-line runner prints the entire file, which buries the one line that matters — measured
 * while negative-controlling this suite. Assert on the boolean and carry the diagnosis in the label.
 */
const expectSource = (file: string, what: string, present: boolean) => expect(present, `${file}: ${what}`).toBe(true)
const has = (text: string, needle: string | RegExp) =>
  typeof needle === "string" ? text.includes(needle) : needle.test(text)

const planFor = (input: {
  rootType: (typeof UNATTENDED)[number] | (typeof ATTENDED)[number]
  backend: AgentJail.BackendInfo
  safeMode?: boolean
}) =>
  HostExec.plan({
    shape: { kind: "shell-command", shell: "/bin/bash", command: "echo hi" },
    cwd: "/w",
    worktree: "/w",
    consent: "none",
    processEnv: { PATH: "/usr/bin" },
    platform: "linux",
    ...input,
  })

describe("① unattended bash is ALLOWED by default (owner 2026-07-30)", () => {
  test("the DEFAULT config is the one this claim is about — `bypass`, whose overlay allows bash", () => {
    // If the shipped default were `ask` or `plan` the jail change would be invisible to a user:
    // `plan` hard-denies `bash`, and under `ask` the evaluator's unattended deny-fast arm converts
    // the consent card into a refusal. So the claim "unattended + default config ⇒ bash allowed"
    // depends on this constant, and a change to it silently un-ships the directive.
    expect(EFFECTIVE_CONFIG_DEFAULTS.permissionMode).toBe("bypass")
    expect(MODE_RULES.bypass).toContainEqual({ action: "bash", resource: "*", effect: "allow" })
  })

  test("an unattended chain on a host with NO sandbox backend now RUNS its command", () => {
    for (const rootType of UNATTENDED) {
      const decision = HostExec.decide({ rootType, backend: NONE })
      expect(decision, `${rootType} on a backend-less host must not be refused`).toBe("raw")
      const plan = planFor({ rootType, backend: NONE })
      // `via: "none"` is the refusal shape — no process is started at all.
      expect(plan.via, `${rootType} produced no runnable plan`).not.toBe("none")
      expect(plan.decision).toBe("raw")
    }
  })

  test("the Linux beachhead is UNTOUCHED — a real backend still confines, safe mode or not", () => {
    // "Allowed by default" means the command RUNS, and a confined command runs. Reading the
    // directive as "stop confining" would delete the one mechanical containment we actually ship.
    for (const rootType of UNATTENDED)
      for (const safeMode of [undefined, false, true]) {
        expect(HostExec.decide({ rootType, backend: FULL, safeMode })).toBe("confined")
        const plan = planFor({ rootType, backend: FULL, safeMode })
        expect(plan.via).toBe("exec")
        if (plan.via === "exec") expect(plan.file).toBe("bwrap")
      }
  })

  test("attended chains are unchanged in every position", () => {
    for (const rootType of ATTENDED)
      for (const safeMode of [undefined, false, true]) {
        expect(HostExec.decide({ rootType, backend: NONE, safeMode })).toBe("raw")
        expect(HostExec.decide({ rootType, backend: FULL, safeMode })).toBe("raw")
      }
  })
})

describe("② safe mode restores the refusal, and the refusal NAMES ITSELF (ruling 2)", () => {
  test("unattended + safe mode + no backend ⇒ refused, with no process planned", () => {
    for (const rootType of UNATTENDED) {
      expect(HostExec.decide({ rootType, backend: NONE, safeMode: true })).toBe("deny")
      const plan = planFor({ rootType, backend: NONE, safeMode: true })
      expect(plan.via).toBe("none")
      if (plan.via === "none") {
        expect(plan.message).toContain("Safe mode is ON")
        expect(plan.message).toContain("Tuning")
        // It must not blame the platform for a refusal the USER asked for — that is the
        // false-fault half of ruling 2, and it is the version a user cannot act on.
        expect(plan.message).not.toContain("no sandbox backend yet")
      }
    }
  })

  test("the switch is INERT in every position it is not about", () => {
    // A switch that quietly changes something else is worse than no switch. Attended chains, a
    // host with a backend, and `safeMode: false` must all be byte-identical to the default.
    for (const rootType of [...ATTENDED, ...UNATTENDED])
      for (const backend of [NONE, FULL])
        expect(HostExec.decide({ rootType, backend, safeMode: false })).toBe(HostExec.decide({ rootType, backend }))
  })

  test("safe mode never buys an untrusted messenger turn the host", () => {
    // The directive reversed the ATTENDANCE arm. The trust arm answers a different adversary
    // (AGENTS.md principle 9(c), todo/jail.md's surviving threat model), so turning safe mode OFF
    // must not relax it — including the `"unknown"` tri-state, where we could not find out.
    for (const hostileInput of [true, "unknown"] as const)
      for (const safeMode of [undefined, false, true]) {
        expect(HostExec.decide({ rootType: "interactive", backend: NONE, hostileInput, safeMode })).toBe("deny")
        expect(HostExec.decide({ rootType: "goal-oriented", backend: NONE, hostileInput, safeMode })).toBe("deny")
        expect(HostExec.decide({ rootType: "interactive", backend: FULL, hostileInput, safeMode })).toBe("confined")
      }
  })

  test("safeMode is a tri-state SessionConfig field with sparse-override inheritance", () => {
    const D = EFFECTIVE_CONFIG_DEFAULTS
    // absent everywhere = OFF (inherit down to the global default, which declares nothing)
    expect(resolveConfig(D, [{}, {}]).safeMode).toBeUndefined()
    // the root sets it; a child that declares nothing INHERITS it
    expect(resolveConfig(D, [{ safeMode: true }, {}]).safeMode).toBe(true)
    // the nearest explicit stance wins — including an explicit `false` (this is what makes it a
    // tri-state rather than a boolean: "off" and "unset" are different rows)
    expect(resolveConfig(D, [{ safeMode: true }, { safeMode: false }]).safeMode).toBe(false)
    expect(resolveConfig(D, [{ safeMode: false }, { safeMode: true }]).safeMode).toBe(true)
    // and it is declared in the fork descriptor (ruling 8's ratchet). Since the `safe_mode` column
    // landed (2026-07-31) the honest classification is `"resolved"`: the chain carries it, so a fork
    // of a safe-mode session is in safe mode — which is what ruling 8 demands of a RESTRICTION.
    // (This line held `"absent-from-row"` while the column did not exist. It was the second of the
    // two ratchets that forced whoever added the column to finish the job.)
    expect(SESSION_CONFIG_FIELDS.safeMode).toBe("resolved")
  })
})

describe("③ the project-scope instruction is in every non-yolo prompt, and absent in yolo", () => {
  test("present in plan / ask / surgical / bypass, ABSENT in yolo", () => {
    for (const mode of ALL_MODES) {
      const section = SystemCompose.projectScopeSection(mode)
      if (mode === "yolo") expect(section, "yolo means everything — it must carry no scope rule").toBeUndefined()
      else expect(section, `${mode} lost the project-scope rule`).toBe(SystemCompose.PROJECT_SCOPE_INSTRUCTION)
    }
  })

  test("it says the thing the owner asked for, in both directions", () => {
    const text = SystemCompose.PROJECT_SCOPE_INSTRUCTION
    // the prohibition
    for (const verb of ["CREATE", "MODIFY", "MOVE", "DELETE"]) expect(text).toContain(verb)
    expect(text.toLowerCase()).toContain("outside")
    // …and the permission, which is not decoration: `permission.ts`'s read baseline ALLOWS
    // out-of-folder reads by default, so a prompt forbidding them would contradict the evaluator
    // and leave the model choosing which of the two to believe.
    expect(text).toContain("READ")
  })

  test("it composes into the runner's part array before the base context, exactly once", () => {
    const parts = {
      persona: "P",
      expertiseHint: "E",
      tierHint: "T",
      memoryRecall: "M",
      systemPromptOverride: "O",
      agentSystem: "A",
      base: "B",
    }
    const withScope = SystemCompose.composeSystemParts({
      ...parts,
      projectScope: SystemCompose.projectScopeSection("bypass"),
    })
    expect(withScope.filter((p) => p === SystemCompose.PROJECT_SCOPE_INSTRUCTION)).toHaveLength(1)
    // after the agent's own prompt (so an agent prompt cannot bury it) and before the base.
    expect(withScope.indexOf(SystemCompose.PROJECT_SCOPE_INSTRUCTION)).toBeGreaterThan(withScope.indexOf("A"))
    expect(withScope.indexOf(SystemCompose.PROJECT_SCOPE_INSTRUCTION)).toBeLessThan(withScope.indexOf("B"))
    // yolo yields the byte-identical pre-feature array — it rides the non-empty filter.
    expect(
      SystemCompose.composeSystemParts({ ...parts, projectScope: SystemCompose.projectScopeSection("yolo") }),
    ).toEqual(SystemCompose.composeSystemParts(parts))
  })
})

describe("④ the WIRING — the half that compiles green when it goes missing", () => {
  // These are source assertions for the same reason three other suites in this tree use them: the
  // runner is win32-skipped (`session-runner.test.ts`) and `tool/bash.ts`'s layer needs a whole
  // location graph, so neither can be executed here. A pure unit that nothing calls is inert, and
  // inert is exactly what a reader cannot see.

  test("tool/bash.ts resolves safe mode and hands it to the ONE gate", () => {
    const text = source("tool/bash.ts")
    expectSource(
      "tool/bash.ts",
      "no longer resolves the session config for safeMode",
      has(text, "resolvedConfig.safeMode"),
    )
    expectSource(
      "tool/bash.ts",
      "the jail decision no longer receives safeMode",
      has(text, /HostExec\.decide\(\{[^}]*safeMode[^}]*\}\)/),
    )
    expectSource(
      "tool/bash.ts",
      "the deny text no longer receives safeMode — it would blame the platform for the user's own switch",
      has(text, /HostExec\.denyMessage\(rootType, hostileInput, safeMode\)/),
    )
    expectSource("tool/bash.ts", "the spawn plan no longer receives safeMode", has(text, /^\s*safeMode,$/m))
  })

  test("tool/bash.ts keeps the operator's credentials off the newly-raw unattended path", () => {
    // Before the reversal, `jailDecision !== "confined"` and "a human could answer" were the SAME
    // predicate, because an unattended chain could never be raw. They are not the same any more,
    // and the old one would hand peer instance tokens + the serve process's environment to
    // model-authored commands in a session nobody is watching (Agent Jail P3).
    const text = source("tool/bash.ts")
    // ⚠️ It must read the GATE'S resolved decision, never re-test `hostileInput` itself — `"unknown"`
    // is not `true`, so a boolean comparison here hands a CONFINED command the operator's whole
    // environment. `test/host-exec.test.ts`'s collapse ledger is the other half of this pin, and it
    // is what caught the first draft of this very line.
    expectSource(
      "tool/bash.ts",
      "the consent predicate is no longer read off the gate's decision",
      has(text, 'const humanCouldAnswer = jailDecision === "raw" && attendedRoot(rootType)'),
    )
    expectSource(
      "tool/bash.ts",
      "consent is no longer keyed on whether a human could answer",
      has(text, 'consent: humanCouldAnswer ? "per-command" : "none"'),
    )
    expectSource(
      "tool/bash.ts",
      "the peer-token gate went back to keying on the jail decision (it now admits unattended raw)",
      !has(text, 'if (jailDecision !== "confined") {'),
    )
  })

  test("the runner composes the project-scope section from the RESOLVED mode", () => {
    const text = source("session/runner/llm.ts")
    expectSource(
      "session/runner/llm.ts",
      "never composes projectScope into the system prompt — the section would be inert",
      has(text, "projectScope: SystemCompose.projectScopeSection(config.permissionMode)"),
    )
    // …and the Strict runner gets the switch too, or safe mode would be honoured by `bash` and
    // silently ignored by every Strict command (ruling 6's whole point).
    expectSource(
      "session/runner/llm.ts",
      "the Strict host no longer carries safeMode — the switch would govern bash and not Strict",
      has(text, "safeMode: resolved.safeMode"),
    )
    expectSource(
      "session/runner/strict.ts",
      "commandPlan drops safeMode on the floor before it reaches the gate",
      has(source("session/runner/strict.ts"), "safeMode: input.host?.safeMode"),
    )
  })
})
