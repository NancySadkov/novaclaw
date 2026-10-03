import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import type { ConfigNudge } from "./config/nudge"
import { Nudge } from "./nudge"

const definition = (hook: ConfigNudge.Hook): ConfigNudge.Info => ({
  id: "test",
  name: "Test",
  enabled: true,
  hook,
  text: "Check this.",
})

describe("Nudge", () => {
  test("ships every built-in guard enabled and marked as a default", () => {
    expect(Nudge.defaults().map((item) => [item.id, item.enabled, item.default])).toEqual([
      [Nudge.LOW_RESOURCE_ID, true, true],
      [Nudge.JAVASCRIPT_TIME_ID, true, true],
      [Nudge.BLOATED_TODO_ID, true, true],
      [Nudge.NEW_DAY_ID, true, true],
      [Nudge.DOOM_LOOP_ID, true, true],
      [Nudge.FAILURE_STREAK_ID, true, true],
      [Nudge.SESSION_RESTART_ID, true, true],
      [Nudge.EMPTY_TURN_ID, true, true],
      [Nudge.ANNOUNCED_TOOL_ID, true, true],
      [Nudge.FINISH_AUDIT_ID, true, true],
      [Nudge.DELEGATE_CHECK_ID, true, true],
      [Nudge.PROJECT_OPTIMIZATION_ID, true, true],
      [Nudge.PROJECT_CLEANUP_ID, true, true],
      [Nudge.STEP_REASONING_ID, true, true],
      [Nudge.STEP_TOOL_ID, true, true],
      [Nudge.STEP_ANSWER_ID, true, true],
      [Nudge.MARKDOWN_BUDGET_ID, true, true],
    ])
  })

  test("the former hardcoded system nudges are now explicit hooks, each selecting its own event", () => {
    const restart = definition({ type: "session-restarted" })
    expect(Nudge.matches(restart, { type: "session-restarted", id: "r1" })).toBe(true)
    expect(Nudge.matches(restart, { type: "empty-turn", id: "e1", count: 1 })).toBe(false)

    const repeated = definition({ type: "repeated-tool", tool: "bash", count: 3, kind: "identical" })
    const call = (over: Partial<{ name: string; count: number; kind: "identical" | "failure" }> = {}) => ({
      type: "repeated-tool" as const,
      id: "d",
      name: over.name ?? "bash",
      input: "x",
      count: over.count ?? 3,
      kind: over.kind ?? ("identical" as const),
    })
    expect(Nudge.matches(repeated, call())).toBe(true)
    expect(Nudge.matches(repeated, call({ name: "read" }))).toBe(false)
    expect(Nudge.matches(repeated, call({ count: 2 }))).toBe(false)
    expect(Nudge.matches(repeated, call({ count: 5 }))).toBe(true)
    expect(Nudge.matches(repeated, call({ kind: "failure" }))).toBe(false)

    const empty = definition({ type: "empty-turn", count: 1 })
    expect(Nudge.matches(empty, { type: "empty-turn", id: "e1", count: 1 })).toBe(true)
    expect(Nudge.matches(empty, { type: "empty-turn", id: "e2", count: 2 })).toBe(false)

    expect(Nudge.matches(definition({ type: "announced-tool" }), { type: "announced-tool", id: "a" })).toBe(true)
    expect(Nudge.matches(definition({ type: "finish-audit" }), { type: "finish-audit", id: "f" })).toBe(true)
    expect(Nudge.matches(definition({ type: "session-restarted" }), { type: "finish-audit", id: "f" })).toBe(false)
  })

  test("step-token budgets fire only above their threshold and only on their own channel", () => {
    const answer = definition({ type: "step-tokens", channel: "answer", tokens: 4_000 })
    const step = (channel: "reasoning" | "answer" | "tool", tokens: number) => ({
      type: "step-tokens" as const,
      id: `s:1:${channel}`,
      channel,
      tokens,
    })
    expect(Nudge.matches(answer, step("answer", 4_000))).toBe(true)
    expect(Nudge.matches(answer, step("answer", 3_999))).toBe(false)
    expect(Nudge.matches(answer, step("reasoning", 40_000))).toBe(false)
    expect(Nudge.matches(answer, step("tool", 40_000))).toBe(false)

    const reasoning = definition({ type: "step-tokens", channel: "reasoning", tokens: 8_000 })
    expect(Nudge.matches(reasoning, step("reasoning", 8_000))).toBe(true)
    expect(Nudge.matches(reasoning, step("reasoning", 7_999))).toBe(false)

    // The occurrence is per step, so a later step over budget is a new event rather than a replay.
    expect(Nudge.occurrence(step("answer", 9_000))).toBe("step-tokens:s:1:answer")
    expect(Nudge.periodic(Nudge.occurrence(step("answer", 9_000)))).toBe(false)
  })

  test("the shipped step budgets name their channel and threshold, and the answer one is the default budget", () => {
    const byId = new Map(Nudge.defaults().map((item) => [item.id, item]))
    expect(byId.get(Nudge.STEP_REASONING_ID)!.hook).toEqual({
      type: "step-tokens",
      channel: "reasoning",
      tokens: 8_000,
    })
    expect(byId.get(Nudge.STEP_TOOL_ID)!.hook).toEqual({ type: "step-tokens", channel: "tool", tokens: 8_000 })
    // The answer budget is the officer parity for the reasoning controller.
    expect(byId.get(Nudge.STEP_ANSWER_ID)!.hook).toEqual({ type: "step-tokens", channel: "answer", tokens: 4_000 })
  })

  test("the doom-loop default names the bash loop and grounds its body in the clock", () => {
    const item = Nudge.defaults().find((entry) => entry.id === Nudge.DOOM_LOOP_ID)!
    expect(item.hook).toEqual({ type: "repeated-tool", tool: "bash", count: 3, kind: "identical" })
    expect(item.text).toBe(
      "Last 3 bash calls got same result. Don't loop - do better. Now is $(date '+%Y-%m-%d %A %H:%M:%S').",
    )
  })

  test("the cadence defaults carry the gates the owner asked for", () => {
    const byId = new Map(Nudge.defaults().map((item) => [item.id, item]))
    const delegate = byId.get(Nudge.DELEGATE_CHECK_ID)!
    expect(delegate.hook).toEqual({ type: "interval", minutes: 60 })
    expect(delegate.minSubordinates).toBe(1)
    expect(delegate.tokenRate).toEqual({ tokens: 20_000, windowSeconds: 3_600 })
    const optimization = byId.get(Nudge.PROJECT_OPTIMIZATION_ID)!
    expect(optimization.hook).toEqual({ type: "interval", minutes: 1_440 })
    expect(optimization.minSubordinates).toBe(1)
    const cleanup = byId.get(Nudge.PROJECT_CLEANUP_ID)!
    expect(cleanup.hook).toEqual({ type: "interval", minutes: 4_320 })
    expect(cleanup.minSubordinates).toBe(1)
    expect(cleanup.requireTmpFolder).toBe(true)
  })

  test("the bloated-file JavaScript hook checks the edited path and byte size", () => {
    const item = Nudge.defaults().find((entry) => entry.id === Nudge.BLOATED_TODO_ID)!
    const matches = (filePath: string, sizeBytes: number) =>
      Nudge.matches(item, { type: "file-edit", id: filePath, path: filePath, sizeBytes })
    expect(matches("C:/work/TODO/plan.txt", 50 * 1024 + 1)).toBe(true)
    expect(matches("C:/work/notes.md", 50 * 1024 + 1)).toBe(true)
    expect(matches("C:/work/Todo.txt", 50 * 1024)).toBe(false)
    expect(matches("C:/work/notes.txt", 50 * 1024 + 1)).toBe(false)
    expect(Nudge.matches(item, { type: "tool", id: "read", name: "read", input: { path: "TODO.txt" } })).toBe(false)
  })

  test("file edit events require a successful text writing tool", () => {
    const directory = "C:/work"
    const edited = (name: string, input: unknown, output: unknown) =>
      Nudge.editedPaths({ type: "tool", id: "x", name, input, output }, directory)
    expect(edited("write", { path: "todo.md" }, { type: "content" })).toEqual([path.resolve(directory, "todo.md")])
    expect(edited("write", { path: "todo.md" }, { type: "error" })).toEqual([])
    expect(edited("read", { path: "todo.md" }, { type: "content" })).toEqual([])
    expect(edited("write-hex", { path: "todo.md" }, { type: "content" })).toEqual([])
    expect(edited("bash", { command: "printf x > todo.md" }, { type: "content" })).toEqual([])
    expect(
      edited("apply_patch", { patchText: "*** Update File: todo.md\n*** Add File: notes.txt" }, { type: "content" }),
    ).toHaveLength(2)
  })

  test("a settled text edit reads the new file size before matching", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-nudge-"))
    try {
      const target = path.join(directory, "todo.md")
      await fs.writeFile(target, "x".repeat(50 * 1024 + 1))
      const event = {
        type: "tool" as const,
        id: "write-1",
        name: "write",
        input: { path: "todo.md" },
        output: { type: "content" },
      }
      const edited = await Nudge.editedFileEvents(event, directory)
      expect(edited).toEqual([{ type: "file-edit", id: `write-1:${target}`, path: target, sizeBytes: 50 * 1024 + 1 }])
      const item = Nudge.defaults().find((entry) => entry.id === Nudge.BLOATED_TODO_ID)!
      expect(Nudge.matches(item, edited[0]!)).toBe(true)
      expect(await Nudge.fileEditEvents(["todo.md"], directory, "snapshot-1")).toEqual([
        { type: "file-edit", id: `snapshot-1:${target}`, path: target, sizeBytes: 50 * 1024 + 1 },
      ])
      expect(await Nudge.editedFileEvents({ ...event, output: { type: "error" } }, directory)).toEqual([])
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test("the time-safety example catches direct timestamp arithmetic and Date construction", () => {
    const item = Nudge.defaults().find((entry) => entry.id === Nudge.JAVASCRIPT_TIME_ID)!
    expect(
      Nudge.matches(item, { type: "tool", id: "a", name: "write", input: { content: "done - message.time.created" } }),
    ).toBe(true)
    expect(
      Nudge.matches(item, { type: "tool", id: "b", name: "write", input: { content: "new Date(event.timestamp)" } }),
    ).toBe(true)
    expect(
      Nudge.matches(item, { type: "tool", id: "c", name: "write", input: { content: "const label = title.trim()" } }),
    ).toBe(false)
  })

  /**
   * 🔴 The owner's report, 2026-09-12 — and the whole reason `write-match` exists.
   *
   * The shipped time-safety nudge's own text tells the agent it *is editing* JavaScript/TypeScript
   * time code, so the trigger has to be an edit. `text-match` is tested against the INPUT and the
   * OUTPUT of EVERY tool call, which made the trigger "text the agent touched anywhere": it fired on
   * files the agent was only READING, and on a shell one-liner that formatted a column. Both firings
   * asserted below are the real ones from this instance's `session_nudge_delivery` table — the
   * owner's session at 02:21Z (a `bash` query over the event log) and a `read` of this repository's
   * own nudge tests. Nothing needed saying in either; the quiet rule cannot help, because it delays a
   * REPEAT and the first delivery in a session is uncapped by design.
   */
  test("the shipped time-safety nudge ignores what the agent reads and matches only what it writes", () => {
    const item = Nudge.defaults().find((entry) => entry.id === Nudge.JAVASCRIPT_TIME_ID)!
    const matches = (name: string, input: unknown, output?: unknown) =>
      Nudge.matches(item, { type: "tool", id: "x", name, input, ...(output === undefined ? {} : { output }) })

    // Nothing to say: a one-off query that formats a SQLite column. `time_created` is snake_case, and
    // the loose `new Date(...)` arm of the pattern is what caught it.
    expect(matches("bash", { command: 'bun -e "console.log(new Date(r.time_created).toISOString())"' })).toBe(false)
    // Nothing to say: reading a file that merely CONTAINS the arithmetic — the tool's output is the
    // world, not the agent's action.
    expect(matches("read", { path: "packages/core/src/nudge.test.ts" }, "done - message.time.created")).toBe(false)
    expect(matches("grep", { pattern: "createdAt" }, "a.ts:12: const t = a.createdAt - b.createdAt")).toBe(false)

    // Something to say: the agent is writing it. This is the firing the nudge was written for.
    expect(matches("write", { content: "const elapsed = endedAt - startedAt" })).toBe(true)
    expect(
      matches("edit", {
        oldString: "const t = 0",
        newString: "const elapsed = message.time.created - message.time.updated",
      }),
    ).toBe(true)
    expect(matches("apply_patch", { patchText: "+  const at = new Date(event.timestamp)" })).toBe(true)
  })

  // ⚠️ The counterpart guarantee: narrowing the SHIPPED default must not narrow anyone else's hook.
  // `text-match` still reads tool output, so a stored nudge that watches for an error string in a
  // command's stderr keeps working — the fix is a new hook, not a redefinition of the old one.
  test("text-match still reads a tool's output, so stored hooks are not silently narrowed", () => {
    expect(
      Nudge.matches(definition({ type: "text-match", pattern: "permission denied" }), {
        type: "tool",
        id: "a",
        name: "bash",
        input: { command: "cat secret" },
        output: "cat: secret: Permission denied",
      }),
    ).toBe(true)
  })

  test("invalid regex is inert rather than crashing a turn", () => {
    expect(
      Nudge.matches(definition({ type: "text-match", pattern: "[" }), {
        type: "tool",
        id: "a",
        name: "write",
        input: "anything",
      }),
    ).toBe(false)
  })

  test("matches MCP prefixes, file operation+extension, compaction, and pressure", () => {
    expect(
      Nudge.matches(definition({ type: "mcp-call", server: "github" }), {
        type: "tool",
        id: "1",
        name: "github_create_issue",
        input: {},
      }),
    ).toBe(true)
    expect(
      Nudge.matches(definition({ type: "file-read", extension: ".ts" }), {
        type: "tool",
        id: "2",
        name: "read",
        input: { path: "src/a.ts" },
      }),
    ).toBe(true)
    expect(
      Nudge.matches(definition({ type: "file-write", extension: "ts" }), {
        type: "tool",
        id: "3",
        name: "read",
        input: { path: "src/a.ts" },
      }),
    ).toBe(false)
    expect(
      Nudge.matches(definition({ type: "file-write", extension: "tsx" }), {
        type: "tool",
        id: "4",
        name: "apply_patch",
        input: { patchText: "*** Begin Patch\n*** Update File: src/a.tsx\n@@\n-old\n+new\n*** End Patch" },
      }),
    ).toBe(true)
    expect(Nudge.matches(definition({ type: "after-compaction" }), { type: "compaction", id: "cmp" })).toBe(true)
    expect(
      Nudge.matches(definition({ type: "resource-pressure", level: "floor" }), {
        type: "resource",
        level: "warning",
        bucket: "h",
      }),
    ).toBe(false)
  })

  test("time windows support ordinary and overnight ranges with one daily occurrence", () => {
    const night = definition({ type: "time-of-day", after: "18:00", before: "06:00" })
    expect(Nudge.matches(night, { type: "clock", at: new Date(2026, 8, 8, 23, 0) })).toBe(true)
    expect(Nudge.matches(night, { type: "clock", at: new Date(2026, 8, 8, 12, 0) })).toBe(false)
    expect(Nudge.occurrence({ type: "clock", at: new Date(2026, 8, 8, 23, 0) })).toBe("clock:2026-09-08")
  })

  test("before and after hooks distinguish tool calls and bash commands", () => {
    const before = { type: "tool-call", tool: "write", phase: "before" } as const
    const shell = { type: "shell-command", pattern: "rm\\s+-r", phase: "before" } as const
    const call = { type: "tool", id: "call-1", name: "write", input: { path: "x" } } as const
    expect(Nudge.matches(definition(before), { ...call, phase: "before" })).toBe(true)
    expect(Nudge.matches(definition(before), { ...call, phase: "after" })).toBe(false)
    expect(
      Nudge.matches(definition(shell), {
        type: "tool",
        id: "call-2",
        name: "bash",
        phase: "before",
        input: { command: "rm -rf x" },
      }),
    ).toBe(true)
    expect(
      Nudge.matches(definition(shell), {
        type: "tool",
        id: "call-2",
        name: "bash",
        phase: "after",
        input: { command: "rm -rf x" },
      }),
    ).toBe(false)
  })

  test("interval occurrences recur by elapsed bucket", () => {
    const item = definition({ type: "interval", minutes: 5 })
    const first = { type: "clock", at: new Date("2026-09-24T10:01:00Z") } as const
    const second = { type: "clock", at: new Date("2026-09-24T10:06:00Z") } as const
    expect(Nudge.matches(item, first)).toBe(true)
    expect(Nudge.occurrenceFor(item, first)).not.toBe(Nudge.occurrenceFor(item, second))
    expect(Nudge.prompt(item)).toContain('nudge({"op":"disable","id":"test"})')
  })

  test("model-judged hooks match the clock tick and take a fresh occurrence", () => {
    const at = new Date("2026-10-02T10:00:00Z")
    const ask = definition({ type: "ask", question: "Is work unfinished?" })
    const prompt = definition({ type: "prompt", request: "Write the next instruction." })
    expect(Nudge.isModelHook(ask.hook)).toBe(true)
    expect(Nudge.isModelHook(prompt.hook)).toBe(true)
    expect(Nudge.isModelHook({ type: "new-day" })).toBe(false)
    expect(Nudge.matches(ask, { type: "clock", at })).toBe(true)
    expect(Nudge.matches(prompt, { type: "clock", at })).toBe(true)
    expect(Nudge.matches(ask, { type: "tool", id: "t", name: "bash", input: {} })).toBe(false)
    expect(Nudge.matches(prompt, { type: "file-edit", id: "f", path: "a.ts", sizeBytes: 1 })).toBe(false)
    // A judged nudge is an EVENT, not a calendar period: two ticks in one day are two occurrences,
    // so the ordinary quiet rule (30 minutes and one epoch) is what bounds repeats.
    expect(Nudge.occurrenceFor(ask, { type: "clock", at })).toBe(`model:${at.getTime()}`)
    expect(Nudge.periodic(Nudge.occurrenceFor(ask, { type: "clock", at }))).toBe(false)
    expect(Nudge.occurrenceFor(ask, { type: "clock", at: new Date(at.getTime() + 1) })).not.toBe(
      Nudge.occurrenceFor(ask, { type: "clock", at }),
    )
  })

  test("a prompt-bodied nudge needs no static text, but an ask hook still does", () => {
    const empty = (hook: ConfigNudge.Hook): ConfigNudge.Info => ({ ...definition(hook), text: "" })
    expect(Nudge.matches(empty({ type: "prompt", request: "Write it." }), { type: "clock", at: new Date() })).toBe(true)
    expect(Nudge.matches(empty({ type: "ask", question: "Anything?" }), { type: "clock", at: new Date() })).toBe(false)
  })

  test("the judge wording is the owner's template, verbatim", () => {
    expect(Nudge.askPrompt("Is it done?", "CTX")).toBe(
      'CTX\n\n---\n\nGiven the above, answer exactly "yes" or "no", if the below holds: Is it done?',
    )
    expect(Nudge.bodyPrompt("Write a nudge", "CTX")).toBe(
      'CTX\n\n---\n\nGiven the above, generate a prompt fulfilling the below ```-quoted request\n```\nWrite a nudge\n```\n\nQuote result in "```"',
    )
    expect(Nudge.answeredYes("Yes.")).toBe(true)
    expect(Nudge.answeredYes("**yes** — it is done")).toBe(true)
    expect(Nudge.answeredYes("No")).toBe(false)
    expect(Nudge.answeredYes("not yet")).toBe(false)
    expect(Nudge.fencedBody("Here you go:\n```\nDo the thing.\n```")).toBe("Do the thing.")
    expect(Nudge.fencedBody("```output\nDo the thing.\n```")).toBe("Do the thing.")
    expect(Nudge.fencedBody("no fence here")).toBeUndefined()
    expect(Nudge.fencedBody("```\n```")).toBeUndefined()
  })
})

describe("withDefaults", () => {
  test("a fresh agent gets every shipped default", () => {
    expect(Nudge.withDefaults(undefined).map((item) => item.id)).toEqual(Nudge.defaults().map((item) => item.id))
  })

  test("an explicit empty list is honored — an officer that wants no nudges keeps none", () => {
    expect(Nudge.withDefaults([])).toEqual([])
  })

  test("an untouched stored resource notice is renamed and reworded; a customized one is left alone", () => {
    const legacy = {
      id: Nudge.LOW_RESOURCE_ID,
      name: "Protect work when resources run low",
      enabled: false,
      hook: { type: "resource-pressure", level: "either" },
      text:
        "This instance is low on memory or disk headroom. Avoid starting memory- or disk-intensive work. " +
        "Use tool_search for resource status, then resource_status for the live figures and confirm recovery before resuming heavy work.",
    } as ConfigNudge.Info
    const migrated = Nudge.withDefaults([legacy]).find((item) => item.id === Nudge.LOW_RESOURCE_ID)!
    expect(migrated.name).toBe("Resources Monitor")
    expect(migrated.text).toBe(
      "This instance is low on memory or disk headroom. Use tool_search for resource status, then resource_status for the live figures.",
    )
    // The user's disabling survives the migration: the wording changed, the choice did not.
    expect(migrated.enabled).toBe(false)

    // A row the user rewrote is theirs — the migration must never clobber an edit.
    expect(
      Nudge.withDefaults([{ ...legacy, text: "Watch the memory please." }]).find(
        (item) => item.id === Nudge.LOW_RESOURCE_ID,
      )?.text,
    ).toBe("Watch the memory please.")
  })

  test("the shipped resource notice reports rather than instructs", () => {
    const item = Nudge.defaults().find((entry) => entry.id === Nudge.LOW_RESOURCE_ID)!
    expect(item.name).toBe("Resources Monitor")
    expect(item.text).toBe(
      "This instance is low on memory or disk headroom. Use tool_search for resource status, then resource_status for the live figures.",
    )
    // The two sentences that made officers chase memory usage are gone.
    expect(item.text).not.toContain("Avoid starting")
    expect(item.text).not.toContain("confirm recovery")
  })

  test("a stored built-in gains the default marker, keeps its choices, and new defaults are merged in", () => {
    const low = Nudge.defaults().find((item) => item.id === Nudge.LOW_RESOURCE_ID)!
    const stored = [
      { ...low, default: undefined, enabled: false },
      { id: "personal", name: "Personal", hook: { type: "after-compaction" }, text: "Keep me." },
    ] as ConfigNudge.Info[]
    const merged = Nudge.withDefaults(stored)
    const first = merged.find((item) => item.id === Nudge.LOW_RESOURCE_ID)!
    expect(first.default).toBe(true)
    expect(first.enabled).toBe(false)
    expect(merged.find((item) => item.id === "personal")?.text).toBe("Keep me.")
    // The cadence defaults shipped after this officer existed must reach it.
    expect(merged.some((item) => item.id === Nudge.DELEGATE_CHECK_ID)).toBe(true)
    // …but an id it already holds is not duplicated.
    expect(merged.filter((item) => item.id === Nudge.LOW_RESOURCE_ID)).toHaveLength(1)
  })
})

/**
 * 🔴 **THE QUIET RULE** — see `Nudge.deliverable` for the reasoning. The owner's report was a nudge
 * that fired on every edit touching a timestamp; these are the four answers the rule has to get
 * right, and each one fails differently if the two caps collapse into one.
 */
describe("the quiet rule", () => {
  const MINUTE = 60_000
  const NOW = 1_789_000_000_000
  const caseOf = (
    over: Partial<{
      occurrence: string
      firedAt: number
      spammable: boolean
      now: number
      compactedAfter: boolean
    }> = {},
  ) => ({
    prior: { occurrence: "tool:call-1", firedAt: over.firedAt ?? NOW - 31 * MINUTE },
    occurrence: over.occurrence ?? "tool:call-2",
    spammable: over.spammable ?? false,
    now: over.now ?? NOW,
    compactedAfter: over.compactedAfter ?? false,
  })

  test("a trigger that fires on every edit delivers once, not on every edit", () => {
    // Same context, five minutes in: the interval floor holds it back.
    expect(Nudge.deliverable(caseOf({ firedAt: NOW - 5 * MINUTE }))).toBe(false)
    // The floor has passed and the context still has not turned over: still quiet. This is the case
    // the shipped time-safety nudge used to fail a thousand times a day.
    expect(Nudge.deliverable(caseOf())).toBe(false)
  })

  test("a compaction re-arms it, because that is where the reminder gets summarised away", () => {
    expect(Nudge.deliverable(caseOf({ compactedAfter: true }))).toBe(true)
    // …but compaction alone does not lift the floor: two compactions forty seconds apart owe the
    // model one reminder, not two.
    expect(Nudge.deliverable(caseOf({ compactedAfter: true, firedAt: NOW - 40_000 }))).toBe(false)
  })

  test("spammable is the opt-out, and it is total — except against a replay", () => {
    expect(Nudge.deliverable(caseOf({ spammable: true, firedAt: NOW - 1_000 }))).toBe(true)
    // The heartbeat the owner named fires every 30 minutes with a changing count; a re-delivery of
    // the SAME occurrence is still a duplicate of one message, not a new beat.
    expect(Nudge.deliverable(caseOf({ spammable: true, occurrence: "tool:call-1" }))).toBe(false)
  })

  test("a nudge whose occurrence IS a period does not wait for a compaction", () => {
    // The new-day notice has to survive a night in which nothing compacts, or the Prompt Hygiene
    // invariant quietly loses its handler.
    expect(Nudge.deliverable(caseOf({ occurrence: "clock:2026-09-12" }))).toBe(true)
    expect(Nudge.deliverable(caseOf({ occurrence: "resource:warning:memory" }))).toBe(true)
    expect(Nudge.periodic("tool:call-2")).toBe(false)
    // A script hook's occurrence is a hash of its output: it changes exactly as often as the output
    // does, so it is NOT a period, and a chatty heartbeat has to say so with `spammable`.
    expect(Nudge.periodic("script:deadbeef")).toBe(false)
  })
})

describe("the Markdown budget", () => {
  const withProject = async (build: (dir: string) => Promise<void>, run: (dir: string) => Promise<void>) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-md-"))
    try {
      await build(dir)
      await run(dir)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }

  test("counts .md recursively, excluding ./tmp and .git", () =>
    withProject(
      async (dir) => {
        await fs.writeFile(path.join(dir, "a.md"), "x")
        await fs.mkdir(path.join(dir, "docs"))
        await fs.writeFile(path.join(dir, "docs", "b.md"), "x")
        await fs.writeFile(path.join(dir, "c.txt"), "x")
        await fs.mkdir(path.join(dir, "tmp"))
        await fs.writeFile(path.join(dir, "tmp", "scratch.md"), "x")
        await fs.mkdir(path.join(dir, ".git"))
        await fs.writeFile(path.join(dir, ".git", "note.md"), "x")
      },
      async (dir) => {
        expect(await Nudge.countProjectMarkdown(dir)).toBe(2)
      },
    ))

  test("createdPaths is a write target or an apply_patch Add, never an Update or an edit", () => {
    expect(
      Nudge.createdPaths({ type: "tool", id: "1", name: "write", input: { path: "New.md", content: "" } }),
    ).toEqual(["New.md"])
    expect(
      Nudge.createdPaths({
        type: "tool",
        id: "2",
        name: "edit",
        input: { path: "old.md", oldString: "a", newString: "b" },
      }),
    ).toEqual([])
    expect(
      Nudge.createdPaths({
        type: "tool",
        id: "3",
        name: "apply_patch",
        input: {
          patchText: "*** Begin Patch\n*** Add File: new.md\n+x\n*** Update File: old.md\n@@\n-a\n+b\n*** End Patch",
        },
      }),
    ).toEqual(["new.md"])
  })

  test("the gate refuses a NEW project .md over the budget, and lets tmp and existing files through", () =>
    withProject(
      async (dir) => {
        await fs.writeFile(path.join(dir, "one.md"), "x")
        await fs.writeFile(path.join(dir, "two.md"), "x")
      },
      async (dir) => {
        const hook = { type: "markdown-budget" as const, count: 1 }
        const write = (target: string) => ({
          type: "tool" as const,
          id: "w",
          name: "write",
          input: { path: target, content: "" },
        })
        expect(await Nudge.markdownBudgetGate({ hook, event: write("new.md"), directory: dir })).toEqual({ count: 2 })
        // ./tmp is the escape hatch the message names.
        expect(await Nudge.markdownBudgetGate({ hook, event: write("tmp/new.md"), directory: dir })).toBeUndefined()
        // Replacing an existing file does not add to the pile.
        expect(await Nudge.markdownBudgetGate({ hook, event: write("one.md"), directory: dir })).toBeUndefined()
        // A non-Markdown write is never gated.
        expect(await Nudge.markdownBudgetGate({ hook, event: write("notes.txt"), directory: dir })).toBeUndefined()
        // Under the budget, creation is allowed.
        expect(
          await Nudge.markdownBudgetGate({ hook: { ...hook, count: 5 }, event: write("new.md"), directory: dir }),
        ).toBeUndefined()
      },
    ))

  test("the shipped Markdown budget refuses with the live count in its exact text", () => {
    const item = Nudge.defaults().find((entry) => entry.id === Nudge.MARKDOWN_BUDGET_ID)!
    expect(item.hook).toEqual({ type: "markdown-budget", count: 20 })
    expect(Nudge.markdownCountText(item.text, 23)).toBe(
      "Project already has 23 .md files. Either create under ./tmp or prune the existing ones.",
    )
  })
})
