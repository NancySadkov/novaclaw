/**
 * Agent Jail P0 — confine execution, don't classify it (notes/agent-jail-plan.md).
 *
 * A prompt-injected shell command cannot be stopped by matching the command STRING (the
 * GuardFall lesson — see the boundary notes in `util/wildcard.ts` and `permission.ts`). Real
 * containment is a platform sandbox: a restricted filesystem view (the worktree + explicit
 * grants) and deny-by-default egress. This module is the capability seam for that sandbox:
 * the backend PROBE (what confinement this host can actually enforce) and the pure POLICY
 * (what an unattended session's bash is allowed to be — raw, confined, or denied).
 *
 * P0 ships the seam with no backend: `probe()` honestly reports `none` everywhere, and the
 * policy's deny arm only engages for UNATTENDED chains (root type auto-prompting /
 * goal-oriented — no human exists to answer an ask, so an out-of-folder write is denied outright).
 * P1 adds the Linux namespace backend (the Spark, the primary target); macOS/Windows follow.
 *
 * ⚠️ THE DENY ARM IS NOW OPT-IN — owner directive, 2026-07-30, and it reverses the stance the
 * paragraph above describes. Verbatim: *"unattended bash should be allowed by default, unless the
 * user have enabled safe mode in tuning. Otherwise the model wont be unable to do any useful work.
 * Yet the model should be instructed by a non-YOLO mode system that it should not modify any files
 * outside of the project's folder. We will defer the AppContainer, etc. to v0.3.0 where we will
 * concentrate on Auth and security related stuff."*
 *
 * What changed, precisely — and it is one arm, not the policy:
 *  · UNATTENDED + a full backend  → still CONFINED. The Linux beachhead is untouched; "allowed by
 *    default" means the command RUNS, and a confined command runs.
 *  · UNATTENDED + no backend      → **raw**, where it used to be `deny`. This is the cost AGENTS.md
 *    ruling 6 accepted out loud (*"unattended Strict on Windows loses `run` until Agent Jail
 *    P4/P5"*), and the owner's judgement is that it makes the product useless for its main job.
 *  · UNATTENDED + no backend + **safe mode** → `deny`, exactly as before. The switch is the opt-in
 *    restoration, not a new posture (see `decideBash`).
 *  · HOSTILE INPUT (an untrusted messenger correspondent drives the turn, or the trust question
 *    could not be answered) → unchanged in every case. That arm answers a different adversary —
 *    *untrusted text arriving as data* (todo/jail.md's surviving threat model, AGENTS.md principle
 *    9(c)) — and the owner's rationale ("the model can't do useful work") does not apply to it: a
 *    stranger's turn being unable to run raw shell blocks nobody's work but the stranger's.
 *
 * The trade is deliberate and it is legible rather than hidden: capability now, **guidance instead
 * of walls** (`session/runner/system-compose.ts` puts a project-scope rule in every non-yolo system
 * prompt), and a switch for anyone who wants the walls back.
 */
export * as AgentJail from "./agent-jail"

import { spawnSync } from "node:child_process"
import { attendedRoot, type SessionType } from "./session/config-resolve"

/**
 * The platform sandbox families the probe can report (notes/agent-jail-plan.md §2.2).
 *
 * ⚠️ Declared as a RUNTIME tuple rather than a bare type union, and that is load-bearing rather than
 * stylistic. The posture surface (Settings → General → *How this machine is confined*) has to be able
 * to NAME whichever of these a host reports, and a `type`-only union is invisible to any test — a
 * fifth member could land with no label anywhere and every check would stay green, which is the
 * ruling-1 defect class exactly. Because the union is DERIVED from this array, adding a member is
 * what makes `packages/app/src/components/settings-v2/confinement.test.ts` demand copy for it.
 */
export const BACKEND_KINDS = ["namespaces", "seatbelt", "appcontainer", "none"] as const
export type BackendKind = (typeof BACKEND_KINDS)[number]

export interface BackendInfo {
  readonly kind: BackendKind
  /** The backend can present a restricted filesystem view (worktree + grants only). */
  readonly fs: boolean
  /** The backend can enforce deny-by-default egress with an allowlist. */
  readonly net: boolean
}

export const NO_BACKEND: BackendInfo = { kind: "none", fs: false, net: false }
export const NAMESPACES: BackendInfo = { kind: "namespaces", fs: true, net: true }

/**
 * ⚠️ WHAT v0.3.0 WILL NEED HERE — recorded at the site rather than in a plan, because the owner
 * asked that the deferral not design the seam shut (2026-07-30: *"we just take that into account
 * for our architecture to avoid tunnel vision"*). AppContainer / Seatbelt / WFP is **deferred to
 * v0.3.0** alongside Auth; do NOT build P4/P5 here. Three facts the next author needs:
 *
 *  1. **`fs` and `net` above are already per-capability booleans, and no backend has ever set them
 *     apart.** `detectBackend` returns all-true (Linux + a working bwrap) or all-false, so the
 *     PARTIAL case — the shape a Windows restricted-token/Job-object backend actually has, since
 *     filesystem confinement and WFP egress filtering are separate mechanisms with separate
 *     failure modes — has never been produced by anything but a test fixture. `decideBash` reads
 *     `fs && net` and collapses a partial backend to the same answer as none.
 *  2. **`BashDecision` has no "confine the filesystem, keep egress" arm.** `raw | confined | deny`
 *     cannot express it, which is why todo/jail.md's B4 correction says the real work is reshaping
 *     the decision into `{fs, net, allow?}` BEFORE any backend lands. A Windows backend bolted onto
 *     today's enum would either claim egress control it does not have (ruling 2 — a fault described
 *     falsely) or throw away the FS containment it does.
 *  3. **`decideBash` takes no permission MODE.** todo/jail.md's standing owner item is *"confine
 *     bash in EVERY non-YOLO mode, attended included"*, and that predicate cannot be written here:
 *     the input does not carry the mode, and widening on attendance alone would kill `npm install`
 *     for every attended Linux session. `safeMode` below is a per-session switch, NOT that mode
 *     predicate — do not mistake one for the other when the reshape happens.
 */

/**
 * P1 Linux probe (pure half): decide the backend from a platform + a bwrap test-runner.
 * The test command is the FULL sandbox shape (`--unshare-all` sets up the empty netns +
 * loopback — the exact step Ubuntu's AppArmor userns restriction breaks when no bwrap
 * profile is installed, measured on the Spark 2026-07-21), so a 0 exit proves BOTH
 * boundaries, not merely that bwrap exists. TEST, never assume from the platform string.
 */
export const PROBE_ARGS = ["--die-with-parent", "--unshare-all", "--ro-bind", "/", "/", "true"] as const

export function detectBackend(
  platform: NodeJS.Platform,
  run: (cmd: string, args: readonly string[]) => number | undefined,
): BackendInfo {
  if (platform !== "linux") return NO_BACKEND
  return run("bwrap", PROBE_ARGS) === 0 ? NAMESPACES : NO_BACKEND
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE POSTURE — what the probe OBSERVED, not only what it concluded.
//
// `detectBackend` answers one question ("can this host confine?") with one bit, and for the DECISION
// that is the whole of it. It is not enough for a surface a person reads, because three completely
// different worlds collapse into its single `NO_BACKEND`:
//
//   · this OS has no backend implemented at all (every non-Linux host today — the probe never ran);
//   · Linux, but `bwrap` is not installed (the probe could not start);
//   · Linux with `bwrap` installed and a POLICY refusing it — the measured Spark failure, where
//     Ubuntu 24.04's `apparmor_restrict_unprivileged_userns=1` with no `/etc/apparmor.d/bwrap`
//     profile makes every sandbox fail (AGENTS.md → The DGX Spark). The probe ran and said no.
//
// Only the third has a fix the user can act on, and telling that user "your platform has no sandbox
// backend" would be ruling 2's *a fault described falsely* — it is not the platform, it is one
// missing file. So the posture keeps the OBSERVATION alongside the verdict.
//
// ⚠️ The verdict itself is still `detectBackend`'s, called below rather than re-derived: a second
// implementation of "what confines this host" is the duplication ruling 6 exists to forbid, and it
// would let the screen and the shell come to disagree. `detectPosture` only WATCHES.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** What running the probe command actually did. Distinguishing these two is the whole point. */
export type ProbeObservation =
  /** The probe binary ran to completion. `status` 0 means the sandbox came up. */
  | { readonly kind: "exited"; readonly status: number }
  /** The probe binary could not be run at all (not installed, no permission, timed out). */
  | { readonly kind: "unavailable"; readonly detail?: string }

export type ProbeRunner = (cmd: string, args: readonly string[]) => ProbeObservation

/**
 * Why this host is (or is not) able to confine. Each arm is a different thing to TELL someone, which
 * is why it is not a boolean — see the block comment above.
 *
 *   · `confined`            — a backend enforces both boundaries; unattended commands run in a box.
 *   · `partial-backend`     — a backend exists but does not enforce BOTH boundaries, so `decideBash`
 *                             cannot use it (the v0.3.0 note above: the shape a Windows
 *                             restricted-token backend has). Nothing is actually confined.
 *   · `platform-unsupported`— no backend is implemented for this platform in this build; the probe
 *                             was never attempted.
 *   · `backend-absent`      — the platform has a backend but its tool could not be run (not installed).
 *   · `backend-blocked`     — the tool ran and the sandbox failed to come up; a host policy refuses it.
 *
 * ⚠️ A runtime tuple for the same reason `BACKEND_KINDS` is one: the posture surface must have copy
 * for every arm, and a `type`-only union cannot be enumerated by the test that checks it.
 */
export const CONFINEMENT_REASONS = [
  "confined",
  "partial-backend",
  "platform-unsupported",
  "backend-absent",
  "backend-blocked",
] as const
export type ConfinementReason = (typeof CONFINEMENT_REASONS)[number]

export interface JailPosture {
  /** The host this was measured on. */
  readonly platform: string
  /** `detectBackend`'s verdict, unmodified — the same value `decideBash` consumes. */
  readonly backend: BackendInfo
  readonly reason: ConfinementReason
  /**
   * The probe that was actually run, if one was. `undefined` means no probe was ATTEMPTED — which is
   * itself the evidence for `platform-unsupported`, and is observed rather than assumed: if a future
   * `detectBackend` learns to probe macOS, this stops saying "unsupported" there with no edit here.
   */
  readonly probe?: { readonly command: string; readonly observation: ProbeObservation }
}

/** Exported for its own test: the `partial-backend` arm is not reachable through `detectPosture`
 *  until a partial backend exists, and an untested arm of a ruling-2 surface is a lie waiting. */
export function confinementReason(backend: BackendInfo, probe: JailPosture["probe"]): ConfinementReason {
  if (backend.fs && backend.net) return "confined"
  if (backend.kind !== "none") return "partial-backend"
  if (!probe) return "platform-unsupported"
  // A probe that ran and left us with no backend is a REFUSAL, whatever its exit status: the tool was
  // reachable, so "not installed" is not the honest answer.
  return probe.observation.kind === "unavailable" ? "backend-absent" : "backend-blocked"
}

/** The pure half of the posture: a platform + a probe runner in, the full observation out. */
export function detectPosture(platform: NodeJS.Platform, run: ProbeRunner): JailPosture {
  let probe: JailPosture["probe"]
  const backend = detectBackend(platform, (cmd, args) => {
    const observation = run(cmd, args)
    probe = { command: [cmd, ...args].join(" "), observation }
    return observation.kind === "exited" ? observation.status : undefined
  })
  return { platform, backend, probe, reason: confinementReason(backend, probe) }
}

/** How long the probe may take before it counts as unavailable. */
export const PROBE_TIMEOUT_MS = 5_000

let probed: JailPosture | undefined

/**
 * What confinement this host can enforce RIGHT NOW, with the evidence.
 *
 * ⚠️ CACHING — this SPAWNS A PROCESS, so it is memoised for the life of the process and there is
 * exactly one spawn per instance, on first use. That is not a performance shortcut: the answer is a
 * HOST-CAPABILITY fact (which kernel, which OS, which AppArmor profile is installed), so it changes
 * about as often as the operating system does and never under a running instance. Installing
 * `/etc/apparmor.d/bwrap` while NovaClaw is up therefore does NOT change what this reports until the
 * instance restarts — which is the honest behaviour, because the running shell tool is caching the
 * same value. Anything that displays this must say what it is showing: the posture this instance
 * measured at startup. `resetProbeCache()` is the test seam and the only invalidation.
 */
export function posture(): JailPosture {
  probed ??= detectPosture(process.platform, (cmd, args) => {
    try {
      const result = spawnSync(cmd, args as string[], { timeout: PROBE_TIMEOUT_MS, stdio: "ignore" })
      // ⚠️ `status` is null for BOTH "could not spawn" and "killed by a signal/timeout", and the old
      // `result.status ?? undefined` collapsed them into the same nothing. `error` is what separates
      // "bwrap is not installed" from "bwrap ran and the kernel refused it" — the one distinction a
      // Linux user can act on.
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code
        return { kind: "unavailable", detail: code ?? result.error.message }
      }
      if (typeof result.status === "number") return { kind: "exited", status: result.status }
      return { kind: "unavailable", detail: result.signal ? `killed by ${result.signal}` : "no exit status" }
    } catch (error) {
      return { kind: "unavailable", detail: error instanceof Error ? error.message : String(error) }
    }
  })
  return probed
}

/**
 * What confinement this host can enforce RIGHT NOW. Cached per process (the answer cannot
 * change under a running instance, and bash calls must not each pay a spawn).
 *
 * Now a projection of `posture()` rather than its own probe — one spawn, one cache, one answer. Two
 * caches would have meant two `bwrap` spawns per process AND a way for the screen and the shell to
 * disagree about the same host.
 */
export function probe(): BackendInfo {
  return posture().backend
}

/** Test seam: clear the per-process probe cache. */
export function resetProbeCache(): void {
  probed = undefined
}

/**
 * Attendance is a property of the chain ROOT — the question is who answers. Children of an
 * interactive root surface asks to a human (attention pills); under an auto-prompting or
 * goal-oriented root there is no one to ask.
 *
 * The predicate itself now lives in the pure config module (`session/config-resolve.ts`) because
 * the PERMISSION evaluator needs the same answer for the unattended confinement stance — one
 * definition of attendance, two consumers. Re-exported here so `AgentJail.attendedRoot` keeps
 * working for existing call sites.
 */
export { attendedRoot }

/**
 * ⚠️ A runtime tuple for the third time, and for the same reason as `BACKEND_KINDS` and
 * `CONFINEMENT_REASONS`: the posture surface renders one phrase per decision, and the wire schema
 * that carries them has to enumerate them. A `type`-only union can be extended with nothing noticing.
 * (todo/jail.md B4 already plans to reshape this into `{fs, net}` for v0.3.0 — when that happens,
 * every consumer that must be updated is reachable from this array.)
 */
export const BASH_DECISIONS = ["raw", "confined", "deny"] as const
export type BashDecision = (typeof BASH_DECISIONS)[number]

/**
 * The pure bash-confinement policy (plan §2.1/§2.3). Evaluated AFTER permission consent:
 * - an ATTENDED chain runs raw, unchanged (a human saw or approved it — the jail is optional
 *   defense-in-depth later, never a P0 behavior change);
 * - an UNATTENDED (or hostile-input) chain runs confined when a backend can enforce both
 *   boundaries — the Linux beachhead, unchanged;
 * - with no (full) backend the answer depends on WHY we are on the contained arm:
 *     · HOSTILE INPUT → `deny`, unchanged. An untrusted stranger drives the turn and there is no
 *       box to put it in; the agent is routed to the path-gated native tools instead.
 *     · UNATTENDED → `raw` by DEFAULT (owner 2026-07-30, see the module header), and `deny` when
 *       the session's **safe mode** switch is on.
 *
 * ⚠️ The ORDER of the last three lines is the whole policy, so read them as one rule rather than
 * three: a real backend always wins (confining is strictly better than either alternative, and it
 * is what "allowed" means where we can enforce it); hostility is checked before the safe-mode
 * escape so the switch can never LOOSEN anything; and only then does the reversal apply. A
 * rearrangement that puts `safeMode` above `hostile` would let a user's Tuning switch decide
 * whether an injected messenger turn gets the host — which is the opposite of what the switch is.
 */
export function decideBash(input: {
  readonly rootType: SessionType
  readonly backend: BackendInfo
  /** A messenger client/audience-driven turn (messenger-plan §3.4): an untrusted stranger — not
   *  the operator — is on the other end, so it is unattended hostile input regardless of the
   *  (usually interactive) chain-root type. Treated exactly like an unattended root. */
  readonly hostileInput?: boolean
  /**
   * The session's resolved **safe mode** (the Tuning switch, `SessionConfig.safeMode`): restore the
   * pre-2026-07-30 containment for the one arm the owner's directive loosened. `undefined`/`false`
   * = the default posture (unattended commands run). It is deliberately NOT a second attendance
   * flag: it cannot make an ATTENDED chain contained (that is todo/jail.md's separate, still-open
   * mode-predicate item), and it cannot RELAX anything — every arm it can reach is a refusal.
   */
  readonly safeMode?: boolean
}): BashDecision {
  const hostile = input.hostileInput === true
  if (attendedRoot(input.rootType) && !hostile) return "raw"
  if (input.backend.fs && input.backend.net) return "confined"
  if (hostile) return "deny"
  if (input.safeMode === true) return "deny"
  return "raw"
}

/**
 * What will ACTUALLY happen on this host, per kind of turn — the four rows a posture surface has to
 * be able to state.
 *
 * ⚠️ Every field is `decideBash`'s own answer, obtained by CALLING it. A surface that restated the
 * policy in its own words would be a normative claim about code in another file — the ruling-1 defect
 * class — and it would go quietly wrong the next time the policy moves, which it did on 2026-07-30
 * and will again when `BashDecision` is reshaped into `{fs, net}` for v0.3.0. The point of this
 * function is that there is nothing here to keep in sync.
 */
export interface BashPlan {
  /** A chat a human is watching (`interactive`). */
  readonly attended: BashDecision
  /** An unattended chain (auto-prompting / goal-oriented) with safe mode off — the default posture. */
  readonly unattended: BashDecision
  /** The same chain with the Tuning *Safe mode* switch on. */
  readonly unattendedSafeMode: BashDecision
  /** A turn driven by an untrusted messenger correspondent, on an otherwise-attended chat. */
  readonly untrusted: BashDecision
}

export function bashPlan(backend: BackendInfo): BashPlan {
  return {
    attended: decideBash({ rootType: "interactive", backend }),
    unattended: decideBash({ rootType: "goal-oriented", backend }),
    unattendedSafeMode: decideBash({ rootType: "goal-oriented", backend, safeMode: true }),
    untrusted: decideBash({ rootType: "interactive", backend, hostileInput: true }),
  }
}

/**
 * The posture flattened for the wire — what an instance reports about itself so a UI (which may be
 * driving this instance from another machine entirely, so it can NEVER answer any of this locally)
 * can state the truth about the host the agent actually runs on.
 *
 * Flat and optional-heavy on purpose: it rides an existing response, and an older client that does
 * not know the field simply ignores it.
 */
export interface JailPostureWire {
  readonly kind: BackendKind
  readonly fs: boolean
  readonly net: boolean
  readonly reason: ConfinementReason
  /** The exact command that was run, so the claim is checkable by hand. Absent = no probe attempted. */
  readonly probeCommand?: string
  readonly probeExit?: number
  readonly probeError?: string
  readonly bash: BashPlan
}

export function postureWire(value: JailPosture): JailPostureWire {
  const observation = value.probe?.observation
  return {
    kind: value.backend.kind,
    fs: value.backend.fs,
    net: value.backend.net,
    reason: value.reason,
    ...(value.probe === undefined ? {} : { probeCommand: value.probe.command }),
    ...(observation?.kind === "exited" ? { probeExit: observation.status } : {}),
    ...(observation?.kind === "unavailable" && observation.detail !== undefined
      ? { probeError: observation.detail }
      : {}),
    bash: bashPlan(value.backend),
  }
}

export interface WrapArgvInput {
  /** The session's location directory — the ONE writable bind (the blast radius). */
  readonly worktree: string
  /** The resolved working directory for the command (inside the worktree). */
  readonly cwd: string
  /**
   * The EXACT argv exec'd inside the sandbox. Not a shell + command string: `tool/js.ts` runs
   * `<runtime> -e <program>`, so a wrapper that hardcodes `-c` cannot express every confined
   * caller. The `<shell> -c <command>` form is `wrapArgs` below, sugar over this.
   */
  readonly argv: readonly string[]
}

export interface WrapInput {
  /** The session's location directory — the ONE writable bind (the blast radius). */
  readonly worktree: string
  /** The resolved working directory for the command (inside the worktree). */
  readonly cwd: string
  /** The shell binary path that will run the command (`<shell> -c <command>`). */
  readonly shell: string
  readonly command: string
}

/**
 * P1: the bwrap argv for a confined command (pure — unit-testable on any platform; the shape
 * is the one mechanism-gated live on the Spark 2026-07-21: egress fails closed, a recursive
 * delete of the fs root touches only the worktree bind, gcc compile+run works). Order is
 * load-bearing: the `--tmpfs /home` mask precedes the worktree bind, so a worktree UNDER /home
 * is re-bound writable while the rest of the user's home stays invisible. `/etc` is ro-bound
 * (TLS certs, passwd) — read-only and egress-dead, an accepted P1 exposure; env scrubbing is P3.
 *
 * P2 — the network boundary IS the OFF-C backstop. `--unshare-all` includes `--unshare-net`:
 * the command runs in an empty network namespace with only an isolated loopback, so ALL egress
 * fails closed — loopback (the host vLLM), LAN, WAN, AND a raw socket (`/dev/tcp`) that ignores
 * `*_PROXY` entirely. That raw-socket path is the exact static-binary class the OFF-C env
 * overlay could never stop (offline.ts §OFF-C); the netns closes it. So for a confined
 * (unattended) command the offline `*_PROXY` overlay is REDUNDANT — kept only as harmless
 * belt-and-braces and as the sole guard on the raw/attended path. Proof: the committed
 * `tests/agent-jail-netns-smoke.sh` (the OFF-C residue's named "network-namespace smoke test").
 * Denying loopback/LAN too is correct, not a gap: the bash child never needs the provider (the
 * KERNEL makes model calls) nor LAN search (the web/kb tools ride the kernel HttpClient).
 */
export function wrapArgv(input: WrapArgvInput): string[] {
  return [
    "--die-with-parent",
    "--unshare-all",
    ...["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/opt"].flatMap((dir) => ["--ro-bind-try", dir, dir]),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/home",
    "--tmpfs",
    "/root",
    "--bind",
    input.worktree,
    input.worktree,
    "--chdir",
    input.cwd,
    "--",
    ...input.argv,
  ]
}

/** The `<shell> -c <command>` form of `wrapArgv`. */
export function wrapArgs(input: WrapInput): string[] {
  return wrapArgv({ worktree: input.worktree, cwd: input.cwd, argv: [input.shell, "-c", input.command] })
}

// P3 — privilege self-revocation: the functional, NON-SECRET env keys an unattended confined
// command is allowed to inherit. Everything else — provider API keys, peer instance tokens, any
// secret the operator exported into the serve process — is DROPPED. A confined command must never
// carry credentials it cannot be supervised using; project-local needs come from the worktree
// bind (a repo .env the command sources), never the host environment. The allowlist covers what a
// build/shell legitimately needs (PATH to resolve binaries; HOME/USER/locale/term/tz/tmp), and
// nothing that identifies or authenticates the instance.
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "SHELL",
  "TMPDIR",
] as const

/**
 * The curated, secret-free base environment for an unattended confined command (P3). Copies only
 * the SAFE_ENV_KEYS present in `processEnv`; the caller layers the tool's own functional overlays
 * (shell-bundle PATH, offline egress) on top and passes it with NO env inheritance, so the child
 * sees exactly this set — never the serve process's full environment.
 */
export function unattendedChildEnv(processEnv: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    const value = processEnv[key]
    if (typeof value === "string") out[key] = value
  }
  return out
}

/** The tail every deny text ends with. `HostExec` keeps a byte-identical private copy for the third
 *  reason it owns (`"unknown"` hostility), and `test/host-exec.test.ts` fails if the two drift. */
const DENY_ROUTING =
  `Use the native tools instead — read/edit/write/create/glob/grep cover file work and are ` +
  `permission-gated per path. Do not retry the same command.`

/**
 * The model-legible routing text for a `deny` (1P house style: teach the way forward).
 *
 * ⚠️ Ruling 2 — *a fault is never described falsely* — is why this takes three arms rather than
 * formatting one sentence. The reasons are genuinely different things to be told, and only one of
 * them the user can act on:
 *  · `hostileInput` names the real cause (a client/audience-driven turn) rather than the chain-root
 *    type, which for those turns is usually the misleading "interactive". It is checked FIRST
 *    because it is the arm `decideBash` reaches first, so the text cannot claim safe mode caused a
 *    refusal that would have happened with the switch off.
 *  · `safeMode` names the switch and where to turn it off. Without this arm a user who ticked Safe
 *    mode would read the legacy sentence below — "this platform has no sandbox backend yet" — and
 *    conclude the product is broken, when the honest answer is "you asked for this, here is the
 *    knob".
 *  · the legacy unattended sentence remains for the `"unknown"`-chain path (`rootSessionType`
 *    narrows an unreadable chain to `goal-oriented`) and for any caller that denies without
 *    declaring why.
 */
export function denyMessage(rootType: SessionType, hostileInput?: boolean, safeMode?: boolean): string {
  const reason = hostileInput
    ? `This turn is driven by an untrusted messenger chat, so raw shell execution is unavailable and this host has no sandbox backend yet. `
    : safeMode === true
      ? `Safe mode is ON for this session, so an unattended shell command has to be sandbox-confined — ` +
        `and this host has no sandbox backend, so it is refused rather than run with the host user's ` +
        `full authority. Turn Safe mode off in this chat's Tuning controls to allow shell commands here. `
      : `Raw shell execution is not available to ${rootType} sessions on this host: unattended commands require sandbox confinement, and this platform has no sandbox backend yet. `
  return reason + DENY_ROUTING
}
