import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * S1: the CLAIMS LEDGER for `session-runner.test.ts`.
 *
 * That file was ruled a SPEC, not a gate (2026-08-05 — see its own header and todo/v0.2.0-prep.md):
 * it has never passed on any platform, it wedges, and its harness is the defect. But its 77 titles
 * are the only written statement of what the drain is supposed to DO — steering and queued-input
 * FIFO, compaction, overflow recovery, durable tool settlement, provider-error projection. The
 * rewrite ports those claims onto a harness that runs on win32; this file makes the porting provable
 * rather than asserted.
 *
 * Each claim ends up in one of three states:
 *   - `spec`    still only in the old file. The starting state of every entry.
 *   - `ported`  an executing replacement exists, so the old test may be deleted.
 *   - `dropped` deliberately not carried over, WITH the reason.
 * A claim may leave this ledger through one of those two doors. Deleting a line is not one of them.
 *
 * The ledger is checked against the suite itself, so it cannot quietly drift: adding, renaming or
 * removing a test there fails here until the ledger says what happened to it. That is the point — a
 * spec nobody can delete by accident, which is exactly how the coverage got lost the first time.
 */

type ClaimStatus = "spec" | "ported" | "dropped"

/** Every `it.effect`/`it.live` title in session-runner.test.ts, verbatim — including the three whose
 * titles are template literals expanded over `fragmentKinds`. Generated from the file, not typed. */
const CLAIMS: readonly string[] = [
  "auto-titles a reasoning model through the shared token-budget controller",
  "advertises and executes a globally attached application tool",
  "starts a real runner turn after default prompt recording",
  "streams one request with registry definitions from chronological V2 user history",
  "retries the first provider turn after system context becomes available",
  "interrupts a source Location runner after a Session moves",
  "fails gracefully when a stored context snapshot cannot be decoded",
  "reuses one durable baseline after the context producer changes",
  "includes the effective default agent system before durable context",
  "uses the configured default agent system for omitted-agent sessions",
  "uses an explicitly selected non-build agent system",
  "updates selected-agent skill guidance after an agent switch",
  "keeps the sampled agent when selection changes during observation",
  "keeps the sampled model when selection changes during model resolution",
  "admits removed context as a chronological System message",
  "keeps the baseline and chronological System updates after a model switch",
  "preserves the baseline while context is temporarily unavailable",
  "rebuilds the baseline directly after completed compaction",
  "automatically compacts into a completed summary and retained recent turn",
  "manual compact runs a compact-only cycle with reason manual and drains no turn",
  "forces one compaction and retries after provider context overflow",
  "persists a second context overflow after one recovery",
  "recovers once from a raw context overflow failure",
  "publishes the original overflow when recovery summarization fails",
  "interrupts overflow recovery while the summary provider is running",
  "preserves effective System updates while compaction rebaseline is blocked",
  "projects reasoning and tool events without executing or continuing tools",
  "continues with reloaded history after durably settling one local tool call",
  "reloads a model switch before a tool-driven continuation turn",
  "restores durable reasoning provider metadata in a second-turn request",
  "replays durable provider-executed tool results inline in a second-turn request",
  "starts recorded local tools eagerly and awaits settlement before continuing",
  "settles repeated provider-local tool call IDs against their owning assistant messages",
  "joins concurrent resume calls into one active provider run",
  "steers an active provider turn with newly recorded prompts",
  "promotes queued input after continuation ends",
  "preserves durable queued input for a later wake after interruption",
  "preserves durable steering input for a later resume after interruption",
  "promotes queued inputs one at a time in FIFO order",
  "promotes queued input after steering continuation ends",
  "promotes steers before the next queued input",
  "coalesces multiple active steering prompts into one continuation turn",
  "runs steering input accepted while the active provider turn fails",
  "durably fails local tools left running by a prior process before continuing",
  "durably fails hosted tools left running by a prior process before continuing inline",
  "durably fails pending tool input left by a prior process before continuing",
  "promotes the first queued input when woken while idle",
  "retries inbox input after prompt projection rolls back",
  "does not strand a committed promotion when a post-commit listener defects",
  "runs different sessions concurrently",
  "bounds 64-character session prompt cache keys",
  "fans out one failed run and allows a later retry",
  "durably settles local tool failures before continuing",
  "returns unexpected local tool defects to the model and continues",
  "interrupts runner continuation when a question is dismissed",
  "awaits started local tools before surfacing provider stream failure",
  "durably fails blocked local tools when a provider turn is interrupted",
  "interrupts a blocked provider turn without local tool execution",
  "durably fails blocked local tools when interrupted while awaiting settlement",
  "forces a text response on an agent's configured final step",
  "resets the configured step allowance when steering input promotes",
  "projects provider errors as terminal assistant step failures",
  "projects provider errors emitted before assistant step start",
  "does not recover context overflow after durable assistant output",
  "projects raw provider stream failures as terminal assistant step failures",
  "accepts a malformed stream tail as broken context and continues without replaying the request",
  "does not continue automatically after a provider error follows a local tool call",
  "durably fails a hosted tool when its provider errors before returning a result",
  "durably fails a hosted tool left unresolved at normal provider EOF",
  "durably fails a hosted tool left unresolved by a raw provider stream failure",
  "keeps interleaved assistant text blocks separate",
  "broadcasts provider ${kind} deltas without storing projection rewrites",
  "durably closes partial ${kind} when the provider stream fails",
  "durably closes partial ${kind} when the provider stream is interrupted",
  "rejects duplicate streamed text starts",
  "transitions streamed raw tool input to parsed called input",
  "rejects malformed streamed tool input ordering",]

/** The suite is the source of truth for what it claims, so this reads it rather than trusting a copy. */
function declaredTitles(): string[] {
  const file = path.join(import.meta.dir, "session-runner.test.ts")
  const source = fs.readFileSync(file, "utf8")
  const titles: string[] = []
  for (const match of source.matchAll(PATTERN)) titles.push(match[2]!)
  return titles
}

const PATTERN = /it\.(?:effect|live)\(\s*(["'`])([\s\S]*?)\1/g

/**
 * The per-claim state. A claim absent from here is `spec` — the starting state — so porting is the
 * only thing that needs writing down.
 *
 * ⚠️ **`ported` means the old test is DELETED, not merely duplicated.** The assertion below enforces
 * exactly that, which is what makes the ledger drive S3's "delete as you go" instead of describing it.
 * Leaving both alive would keep the win32 skip count where it is and quietly double the spec.
 */
const STATUS: Readonly<Record<string, { status: Exclude<ClaimStatus, "spec">; where: string }>> = {
  "streams one request with registry definitions from chronological V2 user history": {
    status: "ported",
    where: "session-runner-turn.test.ts",
  },
  "includes the effective default agent system before durable context": {
    status: "ported",
    where: "session-runner-agent.test.ts",
  },
  "uses the configured default agent system for omitted-agent sessions": {
    status: "ported",
    where: "session-runner-agent.test.ts",
  },
  "uses an explicitly selected non-build agent system": {
    status: "ported",
    where: "session-runner-agent.test.ts",
  },
  "rejects duplicate streamed text starts": {
    status: "ported",
    where: "session-runner-projection.test.ts",
  },
  "rejects malformed streamed tool input ordering": {
    status: "ported",
    where: "session-runner-projection.test.ts",
  },
  "keeps interleaved assistant text blocks separate": {
    status: "ported",
    where: "session-runner-projection.test.ts",
  },
  "transitions streamed raw tool input to parsed called input": {
    status: "ported",
    where: "session-runner-projection.test.ts",
  },
}

describe("the session-runner claims ledger", () => {
  test("the ledger lists exactly what the suite declares, minus what has left it", () => {
    // Checked BOTH ways on purpose. A test that only asserted "every ledger entry still exists" would
    // let a new, untracked test slip in — and an untracked claim is how a spec starts rotting.
    const declared = declaredTitles()
    const expected = CLAIMS.filter((claim) => STATUS[claim] === undefined)
    expect(declared.length, "the suite's declaration count moved — reconcile the ledger").toBe(expected.length)
    expect([...declared].sort(), "a test was added, renamed or removed without a ledger entry").toEqual(
      [...expected].sort(),
    )
  })

  test("🔴 a ported claim is GONE from the old suite, not duplicated in it", () => {
    // The half of "port and delete as you go" that an agent under time pressure skips. Without this,
    // `ported` becomes a label on a claim that still runs nowhere and still costs a win32 skip.
    const declared = new Set(declaredTitles())
    for (const [claim, entry] of Object.entries(STATUS)) {
      expect(declared.has(claim), `"${claim}" is marked ${entry.status} but still declared in the old suite`).toBe(
        false,
      )
    }
  })

  test("every ported claim names where it went, and that file exists", () => {
    for (const [claim, entry] of Object.entries(STATUS)) {
      if (entry.status !== "ported") continue
      expect(entry.where, `"${claim}" is ported but names no replacement file`).toBeTruthy()
      expect(
        fs.existsSync(path.join(import.meta.dir, entry.where)),
        `"${claim}" names ${entry.where}, which does not exist`,
      ).toBe(true)
    }
  })

  test("the remaining claims are the size of the job left", () => {
    // Reads as a progress counter on purpose: while this number is above zero, that many statements
    // about `session/runner/llm.ts` still have NO executing coverage on any platform.
    const remaining = CLAIMS.filter((claim) => STATUS[claim] === undefined)
    expect(remaining.length).toBe(CLAIMS.length - Object.keys(STATUS).length)
    expect(remaining.length).toBe(69)
  })

  test("the remaining declarations are 75 tests, and the ledger knows why", () => {
    // The two numbers look like a discrepancy until you know about the loop: three titles are template
    // literals iterated over `fragmentKinds`, which has three entries, so those three declarations
    // produce nine tests. That is how the ledger stays tied to something observable — this is the exact
    // win32 skip count `bun test test/session-runner.test.ts` reports for the file, and
    // `script/test-baseline.json`'s `units.core` must move with it on every ported slice.
    //
    // It was 77 → 83 when the ledger landed; eight ported claims (none parameterised) make it 69 → 75.
    const remaining = CLAIMS.filter((claim) => STATUS[claim] === undefined)
    const parameterised = remaining.filter((claim) => claim.includes("${kind}"))
    expect(parameterised.length).toBe(3)
    const FRAGMENT_KINDS = 3
    expect(remaining.length - parameterised.length + parameterised.length * FRAGMENT_KINDS).toBe(75)
  })
})
