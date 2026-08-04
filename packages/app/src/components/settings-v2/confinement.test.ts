import { describe, expect, test } from "bun:test"
import { AgentJail } from "@novaclaw/core/agent-jail"
import { dict as en } from "@/i18n/en"
import {
  BACKENDED_PLATFORMS,
  TURN_KINDS,
  confinementState,
  type ConfinementState,
  type ShellStatusWithJail,
} from "./confinement"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The confinement-surface ratchet (ruling 1 — an invariant with no mechanical check does not exist).
//
// The surface makes claims about the kernel's jail, in a different package, from copy that lives in a
// third file. Three ways that goes silently wrong, one test each:
//
//   1. The kernel gains a backend (Seatbelt, AppContainer — both already named in `BackendKind` and
//      both scheduled for v0.3.0) and the screen has no words for it. Every check stays green while
//      a user reads a blank.
//   2. The kernel gains a REASON — the shape of `decideBash` is already slated to change — and the
//      screen renders a missing key at them.
//   3. `BACKENDED_PLATFORMS` — the one thing this screen infers rather than receives — drifts away
//      from what `detectBackend` actually does, so the UI tells a macOS user "no sandbox" the day a
//      Seatbelt backend ships, or tells a Linux user "no sandbox" when it means "I did not ask".
//
// Each is checked by driving the KERNEL and comparing, never by restating it here.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const keys = new Set(Object.keys(en))
const has = (key: string) => keys.has(key)

/** Every platform string Node can report that we might plausibly meet, plus a couple we will not. */
const PLATFORMS: NodeJS.Platform[] = ["win32", "darwin", "linux", "freebsd", "openbsd", "sunos", "aix", "android"]

describe("confinement surface", () => {
  test("BACKENDED_PLATFORMS is what detectBackend actually implements, not a guess", () => {
    // A platform "has a backend" iff the kernel's own detector can produce one for it. Ask it, with a
    // runner that succeeds — the most generous possible answer — and take the set that comes back.
    const implemented = PLATFORMS.filter((platform) => AgentJail.detectBackend(platform, () => 0).kind !== "none")
    expect([...BACKENDED_PLATFORMS].sort()).toEqual([...implemented].sort())
    // Stated separately so a failure says WHICH direction drifted: today it is exactly Linux, and the
    // day that stops being true this line is the one that has to be edited deliberately.
    expect(implemented).toEqual(["linux"])
  })

  test("every backend kind the kernel can name has copy on the screen", () => {
    for (const kind of AgentJail.BACKEND_KINDS) {
      expect(has(`settings.confinement.backend.${kind}`), `no label for backend "${kind}"`).toBe(true)
    }
    // And the enumeration is the real one: a kind produced by the detector must be in the list the
    // loop above walks, or the loop is checking a stale copy of the union.
    for (const platform of PLATFORMS)
      for (const run of [() => 0, () => 1, () => undefined])
        expect(AgentJail.BACKEND_KINDS as readonly string[]).toContain(AgentJail.detectBackend(platform, run).kind)
  })

  test("every confinement reason the kernel can produce has a verdict AND an explanation", () => {
    for (const reason of AgentJail.CONFINEMENT_REASONS) {
      expect(has(`settings.confinement.reason.${reason}`), `no explanation for "${reason}"`).toBe(true)
      expect(has(`settings.confinement.verdict.${reason}`), `no verdict chip for "${reason}"`).toBe(true)
    }
    // The three states that are about the ANSWER rather than the host need the same pair.
    // `checking` is the one that keeps this screen from lying about its OWN request: "still asking"
    // must never render as "could not reach it" while the fetch is in flight.
    for (const kind of ["unreported", "unknown", "checking"]) {
      expect(has(`settings.confinement.reason.${kind}`)).toBe(true)
      expect(has(`settings.confinement.verdict.${kind}`)).toBe(true)
    }
    for (const key of ["unreported", "checking", "none", "exit", "error", "noOutcome"])
      expect(has(`settings.confinement.probe.${key}`), key).toBe(true)
  })

  test("the reasons the kernel actually reaches are all in CONFINEMENT_REASONS", () => {
    // Belt to the type's braces: drive `detectPosture` over the whole input space and confirm every
    // reason it emits is one the loop above demanded copy for.
    const reached = new Set<string>()
    for (const platform of PLATFORMS)
      for (const run of [
        () => ({ kind: "exited", status: 0 }) as const,
        () => ({ kind: "exited", status: 1 }) as const,
        () => ({ kind: "unavailable", detail: "ENOENT" }) as const,
      ])
        reached.add(AgentJail.detectPosture(platform, run).reason)
    for (const reason of reached) expect(AgentJail.CONFINEMENT_REASONS as readonly string[]).toContain(reason)
    // All four host-observable reasons are genuinely reachable — a surface arm nothing can produce is
    // dead copy, and one that IS produced but unlisted is a missing key at a user.
    expect([...reached].sort()).toEqual(["backend-absent", "backend-blocked", "confined", "platform-unsupported"])
  })

  test("TURN_KINDS covers every row of the kernel's BashPlan, and each has copy", () => {
    const planKeys = Object.keys(AgentJail.bashPlan(AgentJail.NO_BACKEND)).sort()
    // `.map(String)` rather than a cast: `Object.keys` is `string[]` while `TURN_KINDS` is the narrow
    // literal tuple, and `toEqual` will not accept the two sides at different widths. Widening the
    // known side is the honest direction — narrowing `planKeys` with an assertion would be claiming
    // the very fact this test exists to check.
    expect([...TURN_KINDS].map(String).sort()).toEqual(planKeys)
    for (const turn of TURN_KINDS) expect(has(`settings.confinement.turn.${turn}`), turn).toBe(true)
  })

  test("every decision the policy can return has copy", () => {
    const partial: AgentJail.BackendInfo = { kind: "appcontainer", fs: true, net: false }
    const decisions = new Set<string>()
    for (const backend of [AgentJail.NO_BACKEND, AgentJail.NAMESPACES, partial])
      for (const value of Object.values(AgentJail.bashPlan(backend))) decisions.add(value)
    expect([...decisions].sort()).toEqual(["confined", "deny", "raw"])
    for (const decision of decisions) expect(has(`settings.confinement.decision.${decision}`), decision).toBe(true)
  })

  // ── the state machine ───────────────────────────────────────────────────────────────────────────

  const shell = (platform: string, jail?: ShellStatusWithJail["jail"]): ShellStatusWithJail =>
    ({
      platform,
      agentShell: "",
      bash: null,
      git: null,
      bundle: null,
      provisionSupported: false,
      jail,
    }) as ShellStatusWithJail

  test("no status at all says UNKNOWN — never 'you are unprotected'", () => {
    const state = confinementState(undefined)
    expect(state.kind).toBe("unknown")
    // Nothing to render as evidence, and nothing invented to fill the gap.
    expect("jail" in state).toBe(false)
    expect(en["settings.confinement.reason.unknown"]).toContain("does not know")
  })

  test("a backend-capable platform with no posture says UNREPORTED, not 'no sandbox'", () => {
    // The AppArmor case is exactly why: on Linux, "there is a backend" and "the backend works" are
    // different facts, and only the instance can answer the second. Guessing either way is ruling 2.
    const state = confinementState(shell("linux"))
    expect(state.kind).toBe("unreported")
    expect(state.kind).not.toBe("confined")
  })

  test("a platform with no backend at all is answered WITHOUT the instance, and honestly", () => {
    for (const platform of ["win32", "darwin"]) {
      const state = confinementState(shell(platform))
      expect(state.kind).toBe("platform-unsupported")
      const posture = (state as Extract<ConfinementState, { jail: unknown }>).jail
      // The verdict the kernel would reach for this platform, and nothing beyond it: no probe was
      // run, so no probe is displayed, and no per-turn outcome table is fabricated locally.
      expect(posture).toEqual({ kind: "none", fs: false, net: false, reason: "platform-unsupported" })
      expect(posture.probeCommand).toBeUndefined()
      expect(posture.bash).toBeUndefined()
      // Cross-check against the kernel rather than against this file's own claim.
      const kernel = AgentJail.detectPosture(platform as NodeJS.Platform, () => {
        throw new Error("must not probe")
      })
      expect(posture.reason).toBe(kernel.reason)
      expect(posture.kind).toBe(kernel.backend.kind)
    }
  })

  test("a reported posture is passed through verbatim — the screen never re-decides", () => {
    const wire = AgentJail.postureWire(AgentJail.detectPosture("linux", () => ({ kind: "exited", status: 1 })))
    const state = confinementState(shell("linux", wire))
    expect(state.kind).toBe("backend-blocked")
    expect((state as Extract<ConfinementState, { jail: unknown }>).jail).toBe(wire)
    // And the outcomes it will render are the kernel's, including the one the loosening created.
    expect(wire.bash.unattended).toBe("raw")
    expect(wire.bash.untrusted).toBe("deny")
  })

  test("the copy states the loosening rather than implying a boundary", () => {
    // The headline a Windows user reads today. It must not promise containment, and it must point at
    // the release that supplies it (ruling 2 + teach-don't-gatekeep).
    const text = en["settings.confinement.reason.platform-unsupported"]
    expect(text).toContain("no operating-system sandbox")
    expect(text).toContain("{{platform}}")
    // The counterweight row exists and names the two guarantees that do NOT depend on the sandbox,
    // and flags the third as guidance rather than a wall.
    const guards = en["settings.confinement.guards.description"]
    expect(guards).toContain("Analyze mode")
    expect(guards).toContain("YOLO")
    expect(guards).toContain("instruction the model follows rather than a wall")
  })
})
