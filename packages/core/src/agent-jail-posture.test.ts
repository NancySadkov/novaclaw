import { describe, expect, test } from "bun:test"
import { AgentJail } from "./agent-jail"
import type { SessionType } from "./session/config-resolve"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The confinement POSTURE — the evidence half of the jail seam (todo/jail.md → "A capability probe +
// an honest posture surface").
//
// Ruling 2 is the whole unit: *an unavailable subsystem names itself instead of rendering empty · a
// fault is never described falsely.* `detectBackend` answers with one bit, and three unrelated
// worlds share its `NO_BACKEND` — no backend exists for this OS · the backend's tool is missing · the
// tool is present and a host policy is refusing it. Only the third is fixable by the person reading
// the screen, so a surface that cannot tell them apart is describing a fault falsely by construction.
//
// What is pinned here:
//   1. each of the five reasons is produced by the input that should produce it;
//   2. "no probe was attempted" is OBSERVED, never inferred from a platform string — so the day
//      `detectBackend` learns to probe macOS, this stops claiming "unsupported" there by itself;
//   3. the verdict is `detectBackend`'s and the four outcomes are `decideBash`'s, both by CALL —
//      there is no restatement of either policy anywhere in the posture;
//   4. `probe()` and `posture()` share ONE cache, i.e. one `bwrap` spawn per process.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const exited =
  (status: number): AgentJail.ProbeRunner =>
  () => ({ kind: "exited", status })
const unavailable =
  (detail?: string): AgentJail.ProbeRunner =>
  () => ({ kind: "unavailable", detail })
const never: AgentJail.ProbeRunner = () => {
  throw new Error("the probe runner must not be called on a platform with no backend")
}

describe("AgentJail posture", () => {
  test("linux + a sandbox that comes up = confined, and the verdict is detectBackend's own", () => {
    const posture = AgentJail.detectPosture("linux", exited(0))
    expect(posture.reason).toBe("confined")
    expect(posture.backend).toEqual(AgentJail.NAMESPACES)
    // Not a lookalike object: the same value decideBash consumes.
    expect(posture.backend).toBe(AgentJail.detectBackend("linux", () => 0))
  })

  test("linux + bwrap NOT installed = backend-absent (the tool could not start)", () => {
    const posture = AgentJail.detectPosture("linux", unavailable("ENOENT"))
    expect(posture.reason).toBe("backend-absent")
    expect(posture.backend).toEqual(AgentJail.NO_BACKEND)
    expect(posture.probe?.observation).toEqual({ kind: "unavailable", detail: "ENOENT" })
  })

  test("linux + bwrap present but REFUSED = backend-blocked, with the exit status kept", () => {
    // The measured Spark failure: Ubuntu 24.04 `apparmor_restrict_unprivileged_userns=1` with no
    // /etc/apparmor.d/bwrap profile. bwrap runs, the userns transition is DENIED, exit 1.
    const posture = AgentJail.detectPosture("linux", exited(1))
    expect(posture.reason).toBe("backend-blocked")
    expect(posture.backend).toEqual(AgentJail.NO_BACKEND)
    expect(posture.probe?.observation).toEqual({ kind: "exited", status: 1 })
    // "absent" and "blocked" must never be the same string — the whole point is that one of them
    // has a fix the user can act on and the other does not.
    expect(posture.reason).not.toBe(AgentJail.detectPosture("linux", unavailable()).reason)
  })

  test("the probe COMMAND is reported verbatim, so the claim is checkable by hand", () => {
    const posture = AgentJail.detectPosture("linux", exited(1))
    expect(posture.probe?.command).toBe(`bwrap ${AgentJail.PROBE_ARGS.join(" ")}`)
    // It must be the FULL sandbox shape, not an existence check — a user who pastes this into a
    // terminal has to reproduce what we measured.
    expect(posture.probe?.command).toContain("--unshare-all")
  })

  test("no probe ATTEMPTED = platform-unsupported, and that is observed rather than assumed", () => {
    for (const platform of ["win32", "darwin"] as const) {
      // `never` throws if it is called at all: this passing is the proof that no process was spawned.
      const posture = AgentJail.detectPosture(platform, never)
      expect(posture.reason).toBe("platform-unsupported")
      expect(posture.probe).toBeUndefined()
      expect(posture.platform).toBe(platform)
    }
  })

  test("a PARTIAL backend is not confinement, and says so in its own words", () => {
    // The v0.3.0 shape the module header names (a Windows restricted-token backend: filesystem
    // containment without egress filtering). `decideBash` reads `fs && net`, so it collapses to the
    // same answer as no backend — but "we have half a box" and "we have no box" are different things
    // to tell someone, and telling a Windows user "no sandbox backend" once one ships would be false.
    const partial: AgentJail.BackendInfo = { kind: "appcontainer", fs: true, net: false }
    expect(AgentJail.confinementReason(partial, undefined)).toBe("partial-backend")
    expect(AgentJail.confinementReason(AgentJail.NAMESPACES, undefined)).toBe("confined")
  })

  test("every kind detectBackend can return is a member of BACKEND_KINDS", () => {
    // The list the UI is required to have copy for. If detectBackend ever returns a kind that is not
    // in it, the surface cannot name the host it is describing.
    const produced = new Set<string>()
    for (const platform of ["win32", "darwin", "linux", "freebsd", "aix"] as NodeJS.Platform[])
      for (const run of [exited(0), exited(1), unavailable()])
        produced.add(AgentJail.detectPosture(platform, run).backend.kind)
    for (const kind of produced) expect(AgentJail.BACKEND_KINDS as readonly string[]).toContain(kind)
    // And the two exported constants, which are what every caller actually holds.
    expect(AgentJail.BACKEND_KINDS as readonly string[]).toContain(AgentJail.NO_BACKEND.kind)
    expect(AgentJail.BACKEND_KINDS as readonly string[]).toContain(AgentJail.NAMESPACES.kind)
  })

  test("bashPlan is decideBash's answer, not a restatement of it", () => {
    const partial: AgentJail.BackendInfo = { kind: "appcontainer", fs: true, net: false }
    for (const backend of [AgentJail.NO_BACKEND, AgentJail.NAMESPACES, partial]) {
      const plan = AgentJail.bashPlan(backend)
      expect(plan.attended).toBe(AgentJail.decideBash({ rootType: "interactive", backend }))
      expect(plan.unattended).toBe(AgentJail.decideBash({ rootType: "goal-oriented", backend }))
      expect(plan.unattendedSafeMode).toBe(AgentJail.decideBash({ rootType: "goal-oriented", backend, safeMode: true }))
      expect(plan.untrusted).toBe(AgentJail.decideBash({ rootType: "interactive", backend, hostileInput: true }))
    }
  })

  test("bashPlan on a backend-less host states the loosening OUT LOUD", () => {
    // This is the fact the whole surface exists to publish (owner directive 2026-07-30): on a host
    // with no backend an unattended chain runs the shell RAW. If this row ever reads "confined" or
    // "deny" by default again, the copy on the Settings screen has become a lie.
    const plan = AgentJail.bashPlan(AgentJail.NO_BACKEND)
    expect(plan).toEqual({
      attended: "raw",
      unattended: "raw",
      unattendedSafeMode: "deny",
      untrusted: "deny",
    })
    expect(AgentJail.bashPlan(AgentJail.NAMESPACES)).toEqual({
      attended: "raw",
      unattended: "confined",
      unattendedSafeMode: "confined",
      untrusted: "confined",
    })
  })

  test("BASH_DECISIONS enumerates everything decideBash can return", () => {
    // The wire schema and the UI copy both enumerate this array. A decision the policy can produce
    // and the array does not list is a value that gets rejected at the schema or rendered as a
    // missing key — so the array is asked to prove itself against the policy, not trusted.
    const partial: AgentJail.BackendInfo = { kind: "appcontainer", fs: true, net: false }
    const produced = new Set<string>()
    const roots: SessionType[] = ["interactive", "sub-agent", "auto-prompting", "goal-oriented"]
    for (const rootType of roots)
      for (const backend of [AgentJail.NO_BACKEND, AgentJail.NAMESPACES, partial])
        for (const hostileInput of [true, false, undefined])
          for (const safeMode of [true, false, undefined])
            produced.add(AgentJail.decideBash({ rootType, backend, hostileInput, safeMode }))
    for (const decision of produced) expect(AgentJail.BASH_DECISIONS as readonly string[]).toContain(decision)
    // And every listed decision is genuinely reachable — dead copy is its own kind of dishonesty.
    expect([...produced].sort()).toEqual([...AgentJail.BASH_DECISIONS].sort())
  })

  test("the plan's four rows cover every root type — none of them silently reads as another", () => {
    // `attended` must speak for BOTH attended root types, or the row is only true for one of them.
    const roots: SessionType[] = ["interactive", "sub-agent"]
    for (const backend of [AgentJail.NO_BACKEND, AgentJail.NAMESPACES])
      for (const rootType of roots)
        expect(AgentJail.decideBash({ rootType, backend })).toBe(AgentJail.bashPlan(backend).attended)
    const unattendedRoots: SessionType[] = ["auto-prompting", "goal-oriented"]
    for (const backend of [AgentJail.NO_BACKEND, AgentJail.NAMESPACES])
      for (const rootType of unattendedRoots)
        expect(AgentJail.decideBash({ rootType, backend })).toBe(AgentJail.bashPlan(backend).unattended)
  })

  test("postureWire carries the evidence, and omits what was never measured", () => {
    const blocked = AgentJail.postureWire(AgentJail.detectPosture("linux", exited(1)))
    expect(blocked.reason).toBe("backend-blocked")
    expect(blocked.probeExit).toBe(1)
    expect("probeError" in blocked).toBe(false)
    expect(blocked.probeCommand).toContain("bwrap")
    expect(blocked.bash.unattended).toBe("raw")

    const absent = AgentJail.postureWire(AgentJail.detectPosture("linux", unavailable("ENOENT")))
    expect(absent.probeError).toBe("ENOENT")
    expect("probeExit" in absent).toBe(false)

    const unsupported = AgentJail.postureWire(AgentJail.detectPosture("win32", never))
    expect(unsupported.reason).toBe("platform-unsupported")
    // ⚠️ Absent, not `null`/`""`: a UI that renders a fabricated empty command would be showing a
    // probe that never happened. The same rule the resource-pressure report follows for "unknown".
    expect("probeCommand" in unsupported).toBe(false)
    expect("probeExit" in unsupported).toBe(false)
    expect("probeError" in unsupported).toBe(false)
    expect(unsupported).toMatchObject({ kind: "none", fs: false, net: false })
  })

  test("posture() and probe() share ONE cache — one spawn per process, one answer", () => {
    AgentJail.resetProbeCache()
    const first = AgentJail.posture()
    // Same object: a second cache would produce an equal-but-distinct value AND a second bwrap spawn.
    expect(AgentJail.posture()).toBe(first)
    expect(AgentJail.probe()).toBe(first.backend)
    // The two surfaces can never disagree about the host, because there is only one of them.
    expect(AgentJail.probe()).toBe(AgentJail.posture().backend)
    AgentJail.resetProbeCache()
    expect(AgentJail.posture()).not.toBe(first)
  })

  test("posture() on THIS host is platform-honest and internally consistent", () => {
    AgentJail.resetProbeCache()
    const live = AgentJail.posture()
    expect(live.platform).toBe(process.platform)
    expect(AgentJail.confinementReason(live.backend, live.probe)).toBe(live.reason)
    if (process.platform !== "linux") {
      expect(live.reason).toBe("platform-unsupported")
      expect(live.probe).toBeUndefined()
      expect(live.backend).toEqual(AgentJail.NO_BACKEND)
    } else {
      // On Linux the probe MUST have been attempted, whatever it concluded.
      expect(live.probe?.command).toContain("bwrap")
    }
  })
})
