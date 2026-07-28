export * as HostExec from "./host-exec"

/**
 * THE host-execution gate (v0.2.0 ruling 6 — `todo/v0.2.0-prep.md`).
 *
 * Containment, the jail decision, shell resolution, environment composition and the egress overlay
 * live HERE, in one module, and every kernel call site that starts a host process consumes it:
 * `tool/bash.ts`, the jh runner (`session/runner/strict.ts` → `jh/process-runner.ts`) and
 * `tool/js.ts`. Duplication is the mechanism that produced the COMSPEC divergence (the `bash` tool
 * honoured `config.shell`, Strict hardcoded `Shell.agentDefault()`) and the far worse Strict
 * environment leak (`{ ...process.env }` — provider API keys and peer instance tokens handed to
 * every model-authored command a Strict run executes). A synchronised second call site is not a
 * fix; one gate is.
 *
 * The module is PURE: no Effect services, no I/O beyond `AgentJail.probe()` (itself cached), so it
 * is unit-testable on any platform and can be called from a plain callback inside the jh runner's
 * plan seam. Everything a caller knows and the gate cannot — the chain-root type, the messenger
 * trust of a turn, the configured shell, the live offline policy, the peer tokens — is INPUT.
 * (`chainHasHostileBinding` returns an Effect, but it holds no service either: both lookups are
 * handed in, so the walk is the same code for the `bash` tool and for the Strict runner.)
 *
 * Two rules the gate owns, and neither is a per-call-site preference:
 *
 *  1. **Confinement** is `AgentJail.decideBash`: an attended chain runs raw; an unattended chain
 *     (or a hostile-input turn) runs confined under a full sandbox backend, and is DENIED when the
 *     host has none. Confined means the child execs `bwrap` with the sandbox argv — the shell is an
 *     argv element, never a spawn option.
 *  2. **Credentials** — the operator's environment reaches a child only when a HUMAN approved THAT
 *     command. `tool/bash.ts` asserts a per-command permission before it runs, so its raw path
 *     inherits the process environment and may carry peer instance tokens. The jh runner and the js
 *     sandbox execute model-authored commands with NO per-command consent, so they always start
 *     from the curated, secret-free base — attended or not, confined or not. A confined command is
 *     uncredentialed in every case (Agent Jail P3).
 */

import { Effect } from "effect"
import { AgentJail } from "./agent-jail"
import { Shell } from "./shell"
import { ShellBundle } from "./shell-bundle"
import type { SessionType } from "./session/config-resolve"

// ── what is being executed ──────────────────────────────────────────────────────────────────────

/**
 * The exec shape. Deliberately NOT "a command string plus a shell": `tool/js.ts` runs
 * `<runtime> -e <program>`, and an abstraction that hardcodes `-c` cannot express it — which is why
 * `AgentJail.wrapArgs` grew an argv form (`wrapArgv`) rather than this module growing a special case.
 */
export type Shape =
  | { readonly kind: "shell-command"; readonly shell: string; readonly command: string }
  | { readonly kind: "runtime-eval"; readonly runtime: string; readonly program: string }

/** The argv a shape becomes when it is exec'd directly (inside the sandbox, or as a plain exec). */
export function argvOf(shape: Shape): string[] {
  return shape.kind === "shell-command"
    ? [shape.shell, "-c", shape.command]
    : [shape.runtime, "-e", shape.program]
}

/**
 * Did a human approve THIS command before it ran?
 *  · `per-command` — yes (`tool/bash.ts` asserts a `bash` permission on the command string).
 *  · `none` — no (the jh/Strict runner and the js sandbox execute what the model wrote).
 * This is the only input to the credential rule, and it is a property of the CALL SITE, not a knob.
 */
export type Consent = "per-command" | "none"

// ── the environment ─────────────────────────────────────────────────────────────────────────────

/**
 * Windows-only functional additions to `AgentJail`'s `SAFE_ENV_KEYS`. None of these identify or
 * authenticate the instance and none is a secret; all of them are load-bearing for a Windows child
 * to work AT ALL — without `SystemRoot` a child cannot initialise winsock (every networked tool
 * fails with an unrelated-looking error), without `TEMP`/`TMP` a native toolchain has nowhere to
 * write, without `USERPROFILE`/`APPDATA` npm/cargo/go cannot find their homes. An allowlist that
 * omits them is not a security posture, it is a broken shell — and the jh runner exists to compile
 * and run things.
 *
 * Applied on win32 only, so the CONFINED path (Linux bwrap, the only platform with a backend) is
 * byte-identical to what `tool/bash.ts` shipped before this module existed. Matched
 * case-insensitively against the real keys, because Windows preserves its own casing (`SystemRoot`,
 * `ComSpec`, `windir`) and the child must receive them in that casing.
 */
const WIN32_FUNCTIONAL_KEYS: ReadonlySet<string> = new Set([
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "OS",
])

/**
 * The curated, secret-free base every uncredentialed or confined child starts from: Agent Jail's
 * P3 allowlist, plus the win32 functional keys above. NEVER the serve process's environment.
 */
export function curatedEnv(
  processEnv: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out = AgentJail.unattendedChildEnv(processEnv)
  if (platform !== "win32") return out
  for (const [key, value] of Object.entries(processEnv))
    if (typeof value === "string" && WIN32_FUNCTIONAL_KEYS.has(key.toUpperCase())) out[key] = value
  return out
}

/** A composed child environment. `inherit: false` REPLACES the parent environment wholesale. */
export interface Env {
  readonly vars: Record<string, string>
  readonly inherit: boolean
}

// ── the request ─────────────────────────────────────────────────────────────────────────────────

/** Everything the gate needs to compose an environment (the half `tool/js.ts` consumes on its own,
 *  because its exec lives behind a runtime probe in `tool/js-run.ts`). */
export interface EnvRequest {
  readonly consent: Consent
  /**
   * The chain ROOT's session type — attendance is a property of the root, never of the session
   * making the call (`AgentJail.attendedRoot`). `undefined` means the CALLER HAS NOT DECLARED IT:
   * the confinement half then cannot engage and the command runs raw. Callers that can know it must
   * pass it; see `SessionHost`.
   */
  readonly rootType?: SessionType
  /** messenger-plan §3.4 — an untrusted stranger drives this turn; treated as unattended. */
  readonly hostileInput?: boolean
  /** Defaults to `AgentJail.probe()` (the real host). Injected in tests and by callers that already
   *  probed, so one command never probes twice. */
  readonly backend?: AgentJail.BackendInfo
  /** Functional, non-secret overlay — the MSYS bundle PATH (`bundleOverlay`). */
  readonly overlay?: Record<string, string> | undefined
  /** OFF-C egress overlay from the SHARED `Offline` service (undefined when offline mode is off).
   *  Never loaded here: a second policy load would drift from the one the HttpClient enforces. */
  readonly egress?: Record<string, string> | undefined
  /** Operator credentials (peer instance tokens). Handed to the child ONLY on a raw, per-command-
   *  approved exec; DROPPED whenever the command is confined or nobody approved it. */
  readonly credentials?: Record<string, string> | undefined
  /** Test seams. */
  readonly processEnv?: Record<string, string | undefined>
  readonly platform?: NodeJS.Platform
}

export interface Request extends EnvRequest {
  readonly shape: Shape
  /** The resolved working directory for the command. */
  readonly cwd: string
  /** The ONE writable bind when confined — the blast radius. The session's location directory for
   *  the `bash` tool; for a Strict run, the folder the run works in (the location, or a racer's
   *  isolated fork, which lives outside it). */
  readonly worktree: string
}

/** The session-side facts only `session/runner/llm.ts` holds, bundled so a call site passes ONE
 *  field. Handed to `SessionStrict.runTask` as `host`. */
export interface SessionHost {
  readonly rootType: SessionType
  readonly hostileInput?: boolean
  /** `config.shell` when the operator set one — the divergence this gate closes. */
  readonly shell?: string
  /** `Offline.egressEnv()` from the shared service. */
  readonly egress?: Record<string, string> | undefined
  readonly backend?: AgentJail.BackendInfo
}

export type Decision = AgentJail.BashDecision

// ── the gate ────────────────────────────────────────────────────────────────────────────────────

/** `config.shell` when set, else the agent default (bundled PortableGit / system bash / COMSPEC).
 *  ONE resolution for the whole product: a Strict run and a normal turn must not speak different
 *  shells on the same host. */
export function resolveShell(configured?: string): string {
  return configured ?? Shell.agentDefault()
}

/** The MSYS-bash userland PATH prefix (`bash -c` is not a login shell), or undefined for any other
 *  shell. */
export function bundleOverlay(shell: string): Record<string, string> | undefined {
  return Shell.name(shell) === "bash" ? ShellBundle.envForBash(shell) : undefined
}

/** The routing text for a denied command (teach the way forward — 1P house style). */
export function denyMessage(rootType: SessionType, hostileInput?: boolean): string {
  return AgentJail.denyMessage(rootType, hostileInput)
}

/** What confinement this host can enforce right now (cached per process). Re-exported so a call
 *  site can probe once and pass the answer to both `decide` and `plan`. */
export function probe(): AgentJail.BackendInfo {
  return AgentJail.probe()
}

// ── hostileInput: the messenger-trust half of the confinement input ─────────────────────────────

/** The only two fields of a messenger binding the trust question turns on. */
export interface ChainBinding {
  readonly status: string
  readonly trust: string
}

/** The two lookups the chain walk needs, injected so this module keeps no service (and so the
 *  `bash` tool and the Strict runner ask the SAME question of the SAME code). Both may fail; a
 *  failure is treated as "no binding here" exactly as the original call site did. */
export interface ChainLookup {
  readonly bindingsForSession: (id: string) => Effect.Effect<ReadonlyArray<ChainBinding>, unknown>
  readonly parentOf: (id: string) => Effect.Effect<string | undefined, unknown>
}

/**
 * messenger-plan §3.4 — is any session in this chain bound to a client/audience chat?
 *
 * An untrusted stranger driving the turn is unattended hostile input regardless of the (usually
 * interactive) chain-root type, and the recommended pattern — a bound session spawning a worker
 * sub-agent — puts the binding on an ANCESTOR, so the whole chain is walked, not just this session.
 *
 * ⚠️ This lived as a closure inside `tool/bash.ts`'s layer, which meant the Strict runner could not
 * ask it without a second copy. A second copy is precisely the mechanism ruling 6 exists to prevent
 * (it is how `bash` and Strict came to speak different shells and different environments), so the
 * walk lives beside the gate that consumes its answer. Short chains, cycle-guarded; most sessions
 * have no binding, so each step is a fast empty indexed lookup.
 */
export function chainHasHostileBinding(sessionID: string, lookup: ChainLookup): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    while (id !== undefined && !seen.has(id)) {
      seen.add(id)
      const bindings: ReadonlyArray<ChainBinding> = yield* lookup
        .bindingsForSession(id)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<ChainBinding> => []))
      if (bindings.some((b) => b.status === "active" && (b.trust === "client" || b.trust === "audience"))) return true
      const parent: string | undefined = yield* lookup
        .parentOf(id)
        .pipe(Effect.orElseSucceed((): string | undefined => undefined))
      id = parent
    }
    return false
  })
}

/**
 * raw · confined · deny. An UNDECLARED root type (`rootType: undefined`) runs raw unless the turn is
 * flagged hostile — the gate cannot invent an attendance it was never told, and refusing every
 * command from a caller that has not been wired yet would delete the feature rather than contain it.
 * The credential half still applies to such a caller, unconditionally.
 */
export function decide(input: {
  readonly rootType?: SessionType
  readonly hostileInput?: boolean
  readonly backend?: AgentJail.BackendInfo
}): Decision {
  const backend = input.backend ?? AgentJail.probe()
  if (input.rootType === undefined)
    return input.hostileInput === true
      ? AgentJail.decideBash({ rootType: "goal-oriented", backend, hostileInput: true })
      : "raw"
  return AgentJail.decideBash({
    rootType: input.rootType,
    backend,
    ...(input.hostileInput === undefined ? {} : { hostileInput: input.hostileInput }),
  })
}

/**
 * Compose the child environment for a request. The ONE place the credential rule is applied, so a
 * new call site cannot re-derive it slightly differently.
 */
export function childEnv(request: EnvRequest): Env {
  const decision = decide({
    ...(request.rootType === undefined ? {} : { rootType: request.rootType }),
    ...(request.hostileInput === undefined ? {} : { hostileInput: request.hostileInput }),
    ...(request.backend === undefined ? {} : { backend: request.backend }),
  })
  // The host-authority path: a human approved this exact command, so the child inherits the
  // operator's environment and may carry the peer tokens an agent drives other instances with.
  if (decision === "raw" && request.consent === "per-command")
    return {
      vars: { ...request.overlay, ...request.egress, ...request.credentials },
      inherit: true,
    }
  // Everything else — confined, or nobody approved it — starts from the curated base with NO
  // inheritance, and the credentials are dropped on the floor.
  return {
    vars: {
      ...curatedEnv(request.processEnv ?? process.env, request.platform ?? process.platform),
      ...request.overlay,
      ...request.egress,
    },
    inherit: false,
  }
}

/**
 * How to start this command, or why it will not be started.
 *  · `via: "none"`  — denied; `message` is the model-facing observation. No process is started.
 *  · `via: "shell"` — run the command STRING through the shell as a spawn option. Load-bearing on
 *    Windows: only the runtime's own shell handling gets `cmd.exe /d /s /c` right; a hand-built
 *    `[shell, "-c", command]` argv is wrong there.
 *  · `via: "exec"`  — exec `file` with `args` and no shell: the confined `bwrap` argv, or a raw
 *    `<runtime> -e <program>`.
 */
export type Plan =
  | { readonly via: "none"; readonly decision: "deny"; readonly message: string }
  | {
      readonly via: "shell"
      readonly decision: "raw"
      readonly shell: string
      readonly command: string
      readonly env: Env
    }
  | {
      readonly via: "exec"
      readonly decision: "raw" | "confined"
      readonly file: string
      readonly args: readonly string[]
      readonly env: Env
    }

export function plan(request: Request): Plan {
  const backend = request.backend ?? AgentJail.probe()
  const decision = decide({
    ...(request.rootType === undefined ? {} : { rootType: request.rootType }),
    ...(request.hostileInput === undefined ? {} : { hostileInput: request.hostileInput }),
    backend,
  })
  const env = childEnv({ ...request, backend })
  if (decision === "deny")
    return {
      via: "none",
      decision,
      // rootType is defined here by construction: `decide` only reaches the deny arm through
      // `AgentJail.decideBash`, and an undeclared root never does.
      message: denyMessage(request.rootType ?? "goal-oriented", request.hostileInput),
    }
  if (decision === "confined")
    return {
      via: "exec",
      decision,
      file: "bwrap",
      args: AgentJail.wrapArgv({ worktree: request.worktree, cwd: request.cwd, argv: argvOf(request.shape) }),
      env,
    }
  if (request.shape.kind === "runtime-eval")
    return {
      via: "exec",
      decision,
      file: request.shape.runtime,
      args: ["-e", request.shape.program],
      env,
    }
  return { via: "shell", decision, shell: request.shape.shell, command: request.shape.command, env }
}

// ── the jh-runner wire shape ────────────────────────────────────────────────────────────────────

/**
 * The plan as `jh/process-runner.ts` consumes it.
 *
 * ⚠️ Why a second declaration exists: §0.7.2 (`jh/imports.test.ts`) forbids every file under
 * `src/jh/` from importing anything off the session/tool/config trees, and this module sits on
 * them. So the jh runner declares the same plain-data shape locally and executes what it is given —
 * it decides NOTHING. The two declarations are pinned STRUCTURALLY: `SessionStrict` passes
 * `HostExec.spawnPlan` straight into `JhProcessRunner.plannedRunner`, so any drift between them is
 * a type error at that call site (and `test/host-exec.test.ts` asserts the assignment explicitly).
 */
export interface SpawnPlan {
  /** The gate refused: no process is started, and this text IS the run's output. */
  readonly denied?: string
  /** Exec this file with this argv (a confined bwrap argv, or `<runtime> -e <program>`). */
  readonly file?: string
  readonly args?: readonly string[]
  /** …or run the command string through this shell binary (the raw path). */
  readonly shell?: string
  readonly env?: Record<string, string>
  /** `false` REPLACES the parent environment; `true` merges over it. */
  readonly inherit?: boolean
}

export function spawnPlan(request: Request): SpawnPlan {
  const p = plan(request)
  if (p.via === "none") return { denied: p.message }
  if (p.via === "exec") return { file: p.file, args: p.args, env: p.env.vars, inherit: p.env.inherit }
  return { shell: p.shell, env: p.env.vars, inherit: p.env.inherit }
}
