import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * S1: the CLAIMS LEDGER for `session-runner.test.ts`.
 *
 * That file was ruled a SPEC, not a gate (2026-08-05 — see its own header and ):
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
  "rejects malformed streamed tool input ordering",
]

const OLD_SUITE = "session-runner.test.ts"

/**
 * The suite is the source of truth for what it claims, so this reads it rather than trusting a copy.
 *
 * It is now GONE — the last claim left on 2026-08-05 — so this returns nothing. It still reads rather
 * than hard-coding `[]`, because that is what makes the ratchet below real: put the file back with a
 * single `it.effect` in it and this ledger fails, naming the claim.
 */
function declaredTitles(): string[] {
  const file = path.join(import.meta.dir, OLD_SUITE)
  if (!fs.existsSync(file)) return []
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
  "projects provider errors as terminal assistant step failures": {
    status: "ported",
    where: "session-runner-errors.test.ts",
  },
  "projects provider errors emitted before assistant step start": {
    status: "ported",
    where: "session-runner-errors.test.ts",
  },
  "bounds 64-character session prompt cache keys": {
    status: "ported",
    where: "session-runner-turn.test.ts",
  },
  "admits removed context as a chronological System message": {
    status: "ported",
    where: "session-runner-context.test.ts",
  },
  "preserves the baseline while context is temporarily unavailable": {
    status: "ported",
    where: "session-runner-context.test.ts",
  },
  "reuses one durable baseline after the context producer changes": {
    status: "ported",
    where: "session-runner-context.test.ts",
  },
  "retries the first provider turn after system context becomes available": {
    status: "ported",
    where: "session-runner-context.test.ts",
  },
  "starts a real runner turn after default prompt recording": {
    status: "ported",
    where: "session-runner-context.test.ts",
  },
  "advertises and executes a globally attached application tool": {
    status: "ported",
    where: "session-runner-tools.test.ts",
  },
  "starts recorded local tools eagerly and awaits settlement before continuing": {
    status: "ported",
    where: "session-runner-tools.test.ts",
  },
  "keeps the sampled model when selection changes during model resolution": {
    status: "ported",
    where: "session-runner-agent.test.ts",
  },
  "steers an active provider turn with newly recorded prompts": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "joins concurrent resume calls into one active provider run": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "coalesces multiple active steering prompts into one continuation turn": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "promotes queued inputs one at a time in FIFO order": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "promotes steers before the next queued input": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "promotes queued input after continuation ends": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "promotes the first queued input when woken while idle": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "preserves durable queued input for a later wake after interruption": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "preserves durable steering input for a later resume after interruption": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "promotes queued input after steering continuation ends": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "runs different sessions concurrently": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "broadcasts provider ${kind} deltas without storing projection rewrites": {
    status: "ported",
    where: "session-runner-fragments.test.ts",
  },
  "durably closes partial ${kind} when the provider stream fails": {
    status: "ported",
    where: "session-runner-fragments.test.ts",
  },
  "durably closes partial ${kind} when the provider stream is interrupted": {
    status: "ported",
    where: "session-runner-fragments.test.ts",
  },
  "continues with reloaded history after durably settling one local tool call": {
    status: "ported",
    where: "session-runner-tools.test.ts",
  },
  "durably settles local tool failures before continuing": {
    status: "ported",
    where: "session-runner-tools.test.ts",
  },
  "returns unexpected local tool defects to the model and continues": {
    status: "ported",
    where: "session-runner-tools.test.ts",
  },
  "durably fails a hosted tool when its provider errors before returning a result": {
    status: "ported",
    where: "session-runner-hosted-tools.test.ts",
  },
  "durably fails a hosted tool left unresolved at normal provider EOF": {
    status: "ported",
    where: "session-runner-hosted-tools.test.ts",
  },
  "durably fails a hosted tool left unresolved by a raw provider stream failure": {
    status: "ported",
    where: "session-runner-hosted-tools.test.ts",
  },
  "durably fails local tools left running by a prior process before continuing": {
    status: "ported",
    where: "session-runner-recovery.test.ts",
  },
  "durably fails hosted tools left running by a prior process before continuing inline": {
    status: "ported",
    where: "session-runner-recovery.test.ts",
  },
  "durably fails pending tool input left by a prior process before continuing": {
    status: "ported",
    where: "session-runner-recovery.test.ts",
  },
  "awaits started local tools before surfacing provider stream failure": {
    status: "ported",
    where: "session-runner-blocked-tools.test.ts",
  },
  "durably fails blocked local tools when a provider turn is interrupted": {
    status: "ported",
    where: "session-runner-blocked-tools.test.ts",
  },
  "restores durable reasoning provider metadata in a second-turn request": {
    status: "ported",
    where: "session-runner-reasoning.test.ts",
  },
  "replays durable provider-executed tool results inline in a second-turn request": {
    status: "ported",
    where: "session-runner-hosted-tools.test.ts",
  },
  "does not continue automatically after a provider error follows a local tool call": {
    status: "ported",
    where: "session-runner-blocked-tools.test.ts",
  },
  "interrupts a blocked provider turn without local tool execution": {
    status: "ported",
    where: "session-runner-blocked-tools.test.ts",
  },
  "durably fails blocked local tools when interrupted while awaiting settlement": {
    status: "ported",
    where: "session-runner-blocked-tools.test.ts",
  },
  "manual compact runs a compact-only cycle with reason manual and drains no turn": {
    status: "ported",
    where: "session-runner-compaction.test.ts",
  },
  "automatically compacts into a completed summary and retained recent turn": {
    status: "ported",
    where: "session-runner-compaction.test.ts",
  },
  "forces one compaction and retries after provider context overflow": {
    status: "ported",
    where: "session-runner-compaction.test.ts",
  },
  "persists a second context overflow after one recovery": {
    status: "ported",
    where: "session-runner-compaction.test.ts",
  },
  "recovers once from a raw context overflow failure": {
    status: "ported",
    where: "session-runner-compaction.test.ts",
  },
  "publishes the original overflow when recovery summarization fails": {
    status: "ported",
    where: "session-runner-compaction.test.ts",
  },
  "does not recover context overflow after durable assistant output": {
    status: "ported",
    where: "session-runner-errors.test.ts",
  },
  "accepts a malformed stream tail as broken context and continues without replaying the request": {
    status: "ported",
    where: "session-runner-errors.test.ts",
  },
  "projects raw provider stream failures as terminal assistant step failures": {
    status: "ported",
    where: "session-runner-errors.test.ts",
  },
  "forces a text response on an agent's configured final step": {
    status: "ported",
    where: "session-runner-steps.test.ts",
  },
  "resets the configured step allowance when steering input promotes": {
    status: "ported",
    where: "session-runner-steps.test.ts",
  },
  "fans out one failed run and allows a later retry": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "runs steering input accepted while the active provider turn fails": {
    status: "ported",
    where: "session-runner-steering.test.ts",
  },
  "auto-titles a reasoning model through the shared token-budget controller": {
    status: "ported",
    where: "session-runner-title.test.ts",
  },
  "projects reasoning and tool events without executing or continuing tools": {
    status: "ported",
    where: "session-runner-projection.test.ts",
  },
  "settles repeated provider-local tool call IDs against their owning assistant messages": {
    status: "ported",
    where: "session-runner-tools.test.ts",
  },
  "fails gracefully when a stored context snapshot cannot be decoded": {
    status: "ported",
    where: "session-runner-context.test.ts",
  },
  "keeps the sampled agent when selection changes during observation": {
    status: "ported",
    where: "session-runner-agent.test.ts",
  },
  "updates selected-agent skill guidance after an agent switch": {
    status: "ported",
    where: "session-runner-agent.test.ts",
  },
  "keeps the baseline and chronological System updates after a model switch": {
    status: "ported",
    where: "session-runner-context.test.ts",
  },
  "rebuilds the baseline directly after completed compaction": {
    status: "ported",
    where: "session-runner-context.test.ts",
  },
  "reloads a model switch before a tool-driven continuation turn": {
    status: "ported",
    where: "session-runner-agent.test.ts",
  },
  "interrupts overflow recovery while the summary provider is running": {
    status: "ported",
    where: "session-runner-compaction.test.ts",
  },
  "preserves effective System updates while compaction rebaseline is blocked": {
    status: "ported",
    where: "session-runner-context.test.ts",
  },
  "retries inbox input after prompt projection rolls back": {
    status: "ported",
    where: "session-runner-promotion.test.ts",
  },
  "does not strand a committed promotion when a post-commit listener defects": {
    status: "ported",
    where: "session-runner-promotion.test.ts",
  },
  "interrupts runner continuation when a question is dismissed": {
    status: "ported",
    where: "session-runner-blocked-tools.test.ts",
  },
  "interrupts a source Location runner after a Session moves": {
    status: "ported",
    where: "session-runner-move.test.ts",
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
    // Read as a progress counter for forty-six slices: while this was above zero, that many statements
    // about `session/runner/llm.ts` had NO executing coverage on any platform. It is now ZERO — every
    // one of the 77 runs on win32.
    const remaining = CLAIMS.filter((claim) => STATUS[claim] === undefined)
    expect(remaining.length).toBe(CLAIMS.length - Object.keys(STATUS).length)
    expect(remaining.length).toBe(0)
  })

  test("🔴 the old suite is DELETED, and cannot come back", () => {
    // The terminal assertion, and the reason this file outlives the job it tracked. S3 finished by
    // deleting `session-runner.test.ts`; without this, nothing stops it being restored — and a restored
    // copy would re-introduce claims that are skipped on win32 while their ported twins pass, which
    // reads as double coverage and is the opposite.
    expect(
      fs.existsSync(path.join(import.meta.dir, OLD_SUITE)),
      `${OLD_SUITE} was deleted when its last claim was ported — it must not return`,
    ).toBe(false)
  })

  test("the remaining declarations are 0 tests, and the ledger knows why", () => {
    // The two numbers look like a discrepancy until you know about the loop: three titles are template
    // literals iterated over `fragmentKinds`, which has three entries, so those three declarations
    // produce nine tests. That is how the ledger stays tied to something observable — this is the exact
    // win32 skip count `bun test test/session-runner.test.ts` reports for the file, and
    // `script/test-baseline.json`'s `units.core` must move with it on every ported slice.
    //
    // It was 77 → 83 when the ledger landed. All seventy-seven are ported, so both are 0 and the file
    // that produced those 83 win32 skips no longer exists. `units.core` in `script/test-baseline.json`
    // moved with it on every slice, which is what kept this ledger tied to something observable rather
    // than to its own bookkeeping.
    const remaining = CLAIMS.filter((claim) => STATUS[claim] === undefined)
    const parameterised = remaining.filter((claim) => claim.includes("${kind}"))
    expect(parameterised.length).toBe(0)
    const FRAGMENT_KINDS = 3
    expect(remaining.length - parameterised.length + parameterised.length * FRAGMENT_KINDS).toBe(0)
  })
})
