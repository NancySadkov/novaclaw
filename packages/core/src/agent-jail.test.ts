import { describe, expect, test } from "bun:test"
import { AgentJail } from "./agent-jail"
import type { SessionType } from "./session/config-resolve"

const FULL: AgentJail.BackendInfo = { kind: "namespaces", fs: true, net: true }
const FS_ONLY: AgentJail.BackendInfo = { kind: "namespaces", fs: true, net: false }

describe("AgentJail", () => {
  test("probe reports no backend on every platform until P1 ships one", () => {
    expect(AgentJail.probe()).toEqual(AgentJail.NO_BACKEND)
  })

  // The full decision matrix (plan §2.1/§2.3): attended chains are untouched; unattended
  // chains run confined only under a backend enforcing BOTH boundaries, else deny.
  const cases: Array<[SessionType, AgentJail.BackendInfo, AgentJail.BashDecision]> = [
    ["interactive", AgentJail.NO_BACKEND, "raw"],
    ["interactive", FULL, "raw"],
    ["sub-agent", AgentJail.NO_BACKEND, "raw"],
    ["auto-prompting", AgentJail.NO_BACKEND, "deny"],
    ["goal-oriented", AgentJail.NO_BACKEND, "deny"],
    ["auto-prompting", FULL, "confined"],
    ["goal-oriented", FULL, "confined"],
    // A partial backend (FS view but no egress control) is NOT containment — deny.
    ["goal-oriented", FS_ONLY, "deny"],
  ]
  for (const [rootType, backend, expected] of cases)
    test(`decideBash(${rootType}, ${backend.kind}/fs:${backend.fs}/net:${backend.net}) = ${expected}`, () => {
      expect(AgentJail.decideBash({ rootType, backend })).toBe(expected)
    })

  test("deny routing text names the session type and the native-tool way forward", () => {
    const message = AgentJail.denyMessage("goal-oriented")
    expect(message).toContain("goal-oriented")
    expect(message).toContain("read/edit/write/create/glob/grep")
    expect(message).toContain("Do not retry")
  })
})
