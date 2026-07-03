// QE-B pure half: step scheduling, write-target extraction, command rendering,
// the failure steer text (config-resolve-style tests; the runner is exercised live).
import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import type { SessionMessage } from "../message"
import { dueMidLoop, dueTurnEnd, failureMessage, initialState, renderCommand, resolve, writeTargets } from "./quality"

const CONFIG = resolve({
  enabled: true,
  commands: { syntax: "parse {file}", check: "verify {file}", typecheck: "tsc -b", test: "bun test", lint: "lint ." },
})

const now = DateTime.nowUnsafe()
const assistant = (tools: Array<{ name: string; path?: string; status?: string }>): SessionMessage.Message =>
  ({
    id: "msg_a1",
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created: now },
    content: tools.map((tool, index) => ({
      type: "tool",
      id: `call_${index}`,
      name: tool.name,
      state: {
        status: tool.status ?? "completed",
        input: tool.path !== undefined ? { path: tool.path } : {},
        content: [],
        structured: {},
      },
      time: { created: now },
    })),
  }) as unknown as SessionMessage.Message

describe("Quality (QE-B pure)", () => {
  test("resolve: defaults off, cadence/testTimeout floors", () => {
    expect(resolve(undefined)).toMatchObject({ enabled: false, cadence: 2, testTimeout: 300_000 })
    expect(resolve({ enabled: true, cadence: 0, testTimeout: 5 })).toMatchObject({ cadence: 2, testTimeout: 300_000 })
    expect(resolve({ enabled: true, cadence: 3, testTimeout: 60_000 })).toMatchObject({ cadence: 3, testTimeout: 60_000 })
  })

  test("writeTargets: newest assistant turn, write-class + completed only, deduped", () => {
    const context = [
      assistant([{ name: "write", path: "old.ts" }]),
      assistant([
        { name: "write", path: "a.ts" },
        { name: "edit", path: "a.ts" },
        { name: "read", path: "ignored.ts" },
        { name: "write", path: "pending.ts", status: "running" },
        { name: "apply_patch", path: "b.ts" },
      ]),
    ]
    expect(writeTargets(context)).toEqual(["a.ts", "b.ts"])
  })

  test("renderCommand: {file} substitution (quoted) or appended", () => {
    expect(renderCommand("parse {file}", "src/x y.ts")).toBe('parse "src/x y.ts"')
    expect(renderCommand("verify", "a.ts")).toBe('verify "a.ts"')
  })

  test("dueMidLoop: syntax+check per file; typecheck on the cadence", () => {
    const state = initialState()
    const first = dueMidLoop(CONFIG, state, ["a.ts"])
    expect(first.map((check) => check.label)).toEqual(["syntax", "check"])
    const second = dueMidLoop(CONFIG, state, ["b.ts"]) // 2nd write → typecheck due (cadence 2)
    expect(second.map((check) => check.label)).toEqual(["syntax", "check", "typecheck"])
    expect(dueMidLoop(CONFIG, state, [])).toEqual([])
    expect(dueMidLoop(resolve({ enabled: false }), initialState(), ["a.ts"])).toEqual([])
  })

  test("dueTurnEnd: once per drain, only after writes", () => {
    const state = initialState()
    expect(dueTurnEnd(CONFIG, state)).toEqual([]) // no writes yet
    dueMidLoop(CONFIG, state, ["a.ts"])
    const due = dueTurnEnd(CONFIG, state)
    expect(due.map((check) => check.label)).toEqual(["test", "lint"])
    expect(due[0]!.timeoutMs).toBe(300_000)
    expect(dueTurnEnd(CONFIG, state)).toEqual([]) // latched
  })

  test("missing commands skip their steps", () => {
    const config = resolve({ enabled: true, commands: { test: "bun test" } })
    const state = initialState()
    expect(dueMidLoop(config, state, ["a.ts"])).toEqual([])
    expect(dueTurnEnd(config, state).map((check) => check.label)).toEqual(["test"])
  })

  test("failureMessage: names the check, carries the output tail, forbids silencing", () => {
    const message = failureMessage({ label: "test", command: "bun test", output: "1 fail", exit: 1 })
    expect(message).toContain("test check failed with exit 1")
    expect(message).toContain("1 fail")
    expect(message).toContain("never silence it")
    expect(failureMessage({ label: "test", command: "x", output: "", timedOut: true })).toContain("timed out")
  })
})
