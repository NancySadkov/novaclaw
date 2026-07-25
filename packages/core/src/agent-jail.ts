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
 * - an UNATTENDED chain runs confined when a backend can enforce both boundaries;
 * - an UNATTENDED chain with no (full) backend is denied raw bash — the agent is routed to
 *   the semantic native tools, which are already path-gated. Removing GuardFall's
 *   precondition structurally, not by filtering.
 */
export function decideBash(input: {
  readonly rootType: SessionType
  readonly backend: BackendInfo
  /** A messenger client/audience-driven turn (messenger-plan §3.4): an untrusted stranger — not
   *  the operator — is on the other end, so it is unattended hostile input regardless of the
   *  (usually interactive) chain-root type. Treated exactly like an unattended root. */
  readonly hostileInput?: boolean
}): BashDecision {
  if (attendedRoot(input.rootType) && input.hostileInput !== true) return "raw"
  if (input.backend.fs && input.backend.net) return "confined"
  return "deny"
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
export function wrapArgs(input: WrapInput): string[] {
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
    input.shell, "-c", input.command,
  ]
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

/** The model-legible routing text for a `deny` (1P house style: teach the way forward). The
 *  `hostileInput` case names the real reason (a client/audience-driven turn) rather than the
 *  chain-root type, which for those turns is usually the misleading "interactive". */
export function denyMessage(rootType: SessionType, hostileInput?: boolean): string {
  const reason = hostileInput
    ? `This turn is driven by an untrusted messenger chat, so raw shell execution is unavailable and this host has no sandbox backend yet. `
    : `Raw shell execution is not available to ${rootType} sessions on this host: unattended commands require sandbox confinement, and this platform has no sandbox backend yet. `
  return (
    reason +
    `Use the native tools instead — read/edit/write/create/glob/grep cover file work and are ` +
    `permission-gated per path. Do not retry the same command.`
  )
}
