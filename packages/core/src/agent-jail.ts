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

/** The platform sandbox families the probe can report (notes/agent-jail-plan.md §2.2). */
export type BackendKind = "namespaces" | "seatbelt" | "appcontainer" | "none"

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

let probed: BackendInfo | undefined

/**
 * What confinement this host can enforce RIGHT NOW. Cached per process (the answer cannot
 * change under a running instance, and bash calls must not each pay a spawn).
 */
export function probe(): BackendInfo {
  probed ??= detectBackend(process.platform, (cmd, args) => {
    try {
      const result = spawnSync(cmd, args as string[], { timeout: 5_000, stdio: "ignore" })
      return result.status ?? undefined
    } catch {
      return undefined
    }
  })
  return probed
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

export type BashDecision = "raw" | "confined" | "deny"

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
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", "/home",
    "--tmpfs", "/root",
    "--bind", input.worktree, input.worktree,
    "--chdir", input.cwd,
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
