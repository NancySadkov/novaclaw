import { describe, expect, test } from "bun:test"

import { GUARD_STALE_MS, isStandingGuard, parseGuardRecord } from "./guard-record"

/**
 * The rule that decides whether `tsgo` runs guarded.
 *
 * Every case here is a way the wrapper could conclude "a guard is up" when none is — the failure that
 * has no symptom, because an unguarded typecheck looks exactly like a guarded one right up until a
 * runaway locks the box.
 */
describe("the guard record needs BOTH halves to agree", () => {
  const now = 1_000_000_000_000
  const live = () => true
  const dead = () => false

  test("a fresh record from a live pid is a standing guard", () => {
    expect(isStandingGuard(`4242 ${now - 2_000}`, now, live)).toBe(true)
  })

  test("a live pid with a STALE beat is not — the pid was reused", () => {
    // This is the case the heartbeat exists for: pid 4242 is alive, but it is somebody else now.
    expect(isStandingGuard(`4242 ${now - GUARD_STALE_MS - 1}`, now, live)).toBe(false)
  })

  test("a fresh beat from a DEAD pid is not — the guard was killed between ticks", () => {
    expect(isStandingGuard(`4242 ${now - 1_000}`, now, dead)).toBe(false)
  })

  test("the OLD bare-pid format reads as no guard, even from a live pid", () => {
    // A record written by a pre-2026-09-03 guard. Erring towards a redundant guard, never an
    // unguarded run, is the whole point of which way this falls.
    expect(isStandingGuard("4242", now, live)).toBe(false)
    expect(parseGuardRecord("4242")).toBeUndefined()
  })

  test("junk and emptiness read as no guard rather than throwing", () => {
    for (const text of ["", "   ", "not-a-pid 12345", "4242 later", "\n"]) {
      expect(isStandingGuard(text, now, live)).toBe(false)
    }
  })

  test("a beat from the FUTURE is not fresh — a moved clock is not a healthy guard", () => {
    expect(isStandingGuard(`4242 ${now + GUARD_STALE_MS + 1}`, now, live)).toBe(false)
  })

  test("trailing whitespace and CRLF survive the round trip", () => {
    expect(isStandingGuard(`4242 ${now - 1_000}\r\n`, now, live)).toBe(true)
    expect(parseGuardRecord(` 7 ${now}  `)).toEqual({ pid: 7, beatMs: now })
  })
})
