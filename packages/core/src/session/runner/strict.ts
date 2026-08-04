export * as SessionStrict from "./strict"

// P14-minimal (jh-improve8 P3): the Strict-harness session route. When `config.strict.enabled` is on
// (the Settings → Strict mode toggle) and the session's permission mode allows autonomous execution,
// the drain routes a turn THROUGH `JhEngine.runTask` instead of the normal LLM loop: the harness owns
// decomposition, per-step compile/run verification, external correction, and recovery (jh.md), and the
// model is asked for exactly one atomic action at a time. This module holds the SESSION-INDEPENDENT
// half — deps assembly, the ConfigStrict→engine-flag mapping, milestone filtering, the generic
// environment text — so it stays unit-testable; the session plumbing (input promotion, model
// resolution, event publishing) lives in the runner and is injected as three narrow capabilities.
//
// v1 scope (jh-improve8.md L3/L4): global toggle only; Synthetic-message progress; jh's own sandboxed
// executor over the session's location directory; NO git checkpoint/revert of a USER project (the tx
// gate + keep-best still protect); persistence via JhStore through `checkpoint`.

import { Effect } from "effect"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { JhArtifact } from "../../jh/artifact"
import { JhBasicTools } from "../../jh/tools-basic"
import { JhBudget } from "../../jh/budget"
import { JhEngine } from "../../jh/engine"
import { JhLog } from "../../jh/log"
import { JhProcessRunner } from "../../jh/process-runner"
import { HostExec } from "../../host-exec"
import { Shell } from "../../shell"
import type { ConfigStrict } from "../../config/strict"
import { SessionInput } from "../input"
import type { SessionMessage } from "../message"
import { Quality } from "./quality"

export const WALL_DEFAULT_MIN = 45
export const MAX_DEPTH = 5
export const MAX_TOTAL_STEPS = 64
// Per-call GENERATION budgets (ConfigStrict.executionTokens / .reasoningTokens). Not the context
// window: a local model is typically served with 128k of context, but each call still needs room to
// finish its own reply. An execution step that truncates loses a half-written file; a reasoning step
// that truncates returns EMPTY (the <think> block never closes, so the parser extracts nothing).
export const EXECUTION_TOKENS_DEFAULT = 24_576
// Where reasoning pays (notes/jh-think-stage.md): the wall goes to decomposition quality and to ruts,
// not to individual atoms — so the stage is scoped rather than charged for on every step.
const THINK_ON = ["decompose", "recover"] as const
/** A budget knob is OFF at 0 (the `attempts: 1 = off` idiom); non-finite/negative is treated as unset. */
const positive = (n: number | undefined): number | undefined =>
  n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
// Best-of-N racing (improve11 P5, jh.md §14.2): forks are BOUNDED plain copies — a copy is strictly
// more faithful than a git clone for "the folder as the user sees it" (uncommitted + untracked files
// come along); .git is excluded (racers don't use git — the git_revert atom is filtered out). Over the
// bounds, racing degrades to a single attempt with a notice (never a silent cap).
export const MAX_FORK_BYTES = 256 * 1024 * 1024
export const MAX_FORK_FILES = 5000
export const MAX_ATTEMPTS = 8
// The workspace render is the model's working set — a session cwd can be a whole user project, so the
// listing is bounded (most-recently-modified first; the tail entry names how many files were omitted).
export const FILE_LIST_CAP = 24
const BINARY_EXTS = new Set([".exe", ".o", ".obj", ".dll", ".so", ".dylib", ".bin", ".a", ".lib"])

// ── P14.1 routing (jh MVP): TASK vs CHAT ────────────────────────────────────────────────────────
// With Strict enabled, EVERY message would otherwise launch a full engine run — including "thanks"
// and "what does that error mean?". One small routing call keeps Strict mode livable: conversational
// messages get a normal turn; only work requests engage the harness.
export const ROUTE_TOKENS = 2048 // headroom for a reasoning model that thinks before its one-word verdict

export const ROUTE_SYSTEM = [
  "You route messages for a work agent that operates on the user's project folder.",
  "Decide whether the user's message is a WORK TASK or ORDINARY CHAT.",
  "A WORK TASK asks for something to be DONE in the folder: create, edit, fix, refactor, build,",
  "install, set up, convert, run, verify, or produce a file, program, document, or dataset.",
  "ORDINARY CHAT is everything else: greetings, thanks, acknowledgements, questions answered in",
  "words, explanations, opinions, status questions, small talk.",
  "Reply with exactly one word: TASK or CHAT.",
].join("\n")

/** Parse the router verdict. Only an EXPLICIT, final CHAT verdict routes away from the engine — the
 *  user turned Strict on, so ambiguity or garbage resolves to their stated stance (TASK). The LAST
 *  token wins because a reasoning model may weigh both words before concluding. */
export function routeOf(reply: string): "task" | "chat" {
  const matches = reply.toUpperCase().match(/\b(TASK|CHAT)\b/g)
  return matches !== null && matches[matches.length - 1] === "CHAT" ? "chat" : "task"
}

// ── P14.1 resume: the continuation intent ───────────────────────────────────────────────────────
// Only these filler words may follow "resume"/"continue" — a message carrying NEW content
// ("continue, but make the button red") must NOT match, or its modifier would be silently lost.
const RESUME_TAIL = new Set([
  "the",
  "that",
  "this",
  "task",
  "run",
  "job",
  "it",
  "work",
  "working",
  "please",
  "with",
  "on",
  "going",
  "go",
  "ahead",
  "from",
  "where",
  "you",
  "we",
  "left",
  "off",
  "stopped",
  "was",
  "were",
  "previous",
  "last",
  "earlier",
  "interrupted",
  "your",
  "my",
  "again",
  "now",
])

/** A bare continuation request ("resume", "continue the task", "resume where you left off") — the
 *  documented way to pick an interrupted Strict run back up (the notices teach the word). */
export function resumeIntent(text: string): boolean {
  const words = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,;…'"“”‘’]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0 || words.length > 7) return false
  if (words[0] !== "resume" && words[0] !== "continue") return false
  return words.slice(1).every((w) => RESUME_TAIL.has(w))
}

// ── P14.1 final answer: the run summary ─────────────────────────────────────────────────────────
export const SUMMARY_TOKENS = 4096
const SUMMARY_LINE_MAX = 240
const SUMMARY_LINES_MAX = 40

/**
 * The two ways a stopped run can leave the folder, said honestly.
 *
 * ⚠️ The kept-best clause used to be UNCONDITIONAL — both here and in the runner's terminal chat
 * notice. It is false in every real Strict session: the engine only writes `bestSnapshot` on a
 * GRADED improvement, and this module supplies no `taskComplete` oracle (and `flagsFor` structurally
 * cannot), so `restoreBest` short-circuits and nothing was ever kept. `JhEngine.Report.keptBest` is
 * the engine's own answer; both surfaces read it (v0.2.0 ruling — *a fault is never described
 * falsely*).
 */
const KEPT_BEST = "the best verified state was kept"
const NO_BEST_HELD = "no separate best-verified state was held"

/** The end-of-run chat notice. Extracted from the runner so the honest wording has ONE home and a
 *  test can drive both directions of `keptBest`. */
export function terminalNotice(input: {
  readonly status: string
  readonly reason?: string
  readonly steps: number
  /** false = best-of-N racing: the run worked in isolated attempt workspaces, not the folder. */
  readonly single: boolean
  /** `JhEngine.Report.keptBest` — REQUIRED, so a caller cannot render the claim without asking. */
  readonly keptBest: boolean
}): string {
  if (input.status === "done") return `✅ Strict task complete — ${input.steps} steps, every one verified.`
  // Racing never touched the folder — the run happened in the attempt workspaces — so both halves
  // name the right place rather than saying "the folder" and being wrong half the time.
  const state = input.keptBest
    ? `${KEPT_BEST} in ${input.single ? "the working directory" : "the attempt workspaces"}`
    : `${NO_BEST_HELD}, so ${input.single ? "the working directory holds" : "the attempt workspaces hold"} the run's last state`
  if (input.reason === "aborted")
    return `⏹️ Strict run stopped at your request after ${input.steps} steps — ${state}. Say "resume" to pick it up again.`
  // The completion gate's own stop, said in words rather than as a reason code. It is a DIFFERENT fact
  // from a wall or a step budget — the run believed it was finished and this project's own verification
  // commands disagreed — and "stopped" alone would hide the only part the user needs (ruling 2: a fault
  // is never described falsely, and "ran out of time" would be a false description of this one).
  if (input.reason === "completion_unverified")
    return `⚠️ Strict stopped after ${input.steps} steps: the work did NOT pass this project's own verification commands, so the task is not reported complete — ${state}. Say "resume" to keep working on it.`
  return `⚠️ Strict run stopped (${input.reason ?? "blocked"}) after ${input.steps} steps — ${state}. Say "resume" to continue it.`
}

/** The prompt pair for the end-of-run assistant summary — the user's readable answer to "what did
 *  you actually do?". Input is harness ground truth only (goal, outcome, the phase-level journal,
 *  applied files) so the summary can't claim more than the run verified. */
export function summaryPrompt(input: {
  readonly goal: string
  readonly status: string
  readonly reason?: string
  readonly milestones: ReadonlyArray<string>
  readonly appliedFiles?: ReadonlyArray<string>
  /** `JhEngine.Report.keptBest` — REQUIRED for the same reason as in `terminalNotice`: the model is
   *  told to base every claim on this block, so a false outcome line becomes a false report. */
  readonly keptBest: boolean
}): { readonly system: string; readonly user: string } {
  const system = [
    "You report the outcome of an autonomous step-by-step work run to the user who requested it.",
    "Write a short, plain-language report: what was produced or changed (name the files), how it",
    "was verified, and — if the run stopped early — exactly what state the folder is in and what",
    "remains to be done. Base every claim ONLY on the journal below; if the journal doesn't show",
    "something was verified, don't claim it works. 3-8 sentences, no headings, no apologies.",
  ].join("\n")
  const outcome =
    input.status === "done"
      ? "completed — every step verified"
      : `stopped early (${input.reason ?? input.status}) — ${input.keptBest ? KEPT_BEST : `${NO_BEST_HELD}; what is on disk is the run's last state`}`
  const journal = input.milestones
    .slice(-SUMMARY_LINES_MAX)
    .map((line) => (line.length > SUMMARY_LINE_MAX ? line.slice(0, SUMMARY_LINE_MAX) + "…" : line))
    .join("\n")
  const applied =
    input.appliedFiles !== undefined && input.appliedFiles.length > 0
      ? `\n\nFiles applied to the folder: ${input.appliedFiles.join(", ")}`
      : ""
  return {
    system,
    user: `The task: ${input.goal}\n\nOutcome: ${outcome}\n\nRun journal (phase-level):\n${journal || "(no phase milestones recorded)"}${applied}`,
  }
}

/** ConfigStrict group toggles → engine lever flags. `undefined` = the engine's default (ON); an
 *  explicit group `false` disables its family (core/src/config/strict.ts documents the mapping). */
export function flagsFor(
  strict: ConfigStrict.Info,
): Pick<
  JhEngine.Deps,
  | "staleness"
  | "regressionGate"
  | "phaseGate"
  | "keepBest"
  | "restoreOnDrop"
  | "ladder"
  | "rederive"
  | "numberedWorkspace"
  | "fullFiles"
  | "txEdits"
  | "coordMode"
  | "budgetAware"
> {
  const off = (group: boolean | undefined) => (group === false ? false : undefined)
  return {
    staleness: off(strict.verification),
    regressionGate: off(strict.verification),
    phaseGate: off(strict.verification),
    keepBest: off(strict.recovery),
    restoreOnDrop: off(strict.recovery),
    ladder: off(strict.recovery),
    rederive: off(strict.recovery),
    numberedWorkspace: off(strict.editingAids),
    fullFiles: off(strict.editingAids),
    txEdits: off(strict.editingAids),
    coordMode: off(strict.editingAids),
    budgetAware: off(strict.budgetSteering),
  }
}

// ── The COMPLETION GATE (v0.2.0) ────────────────────────────────────────────────────────────────
//
// jh.md §14.1 states the law this closes: *push everything checkable out of the model's head into
// executed, mechanical checks — and treat whatever remains (judge calls, self-assessments) as fallible
// input under suspicion machinery, never as ground truth.* Until now the whole-task authority in a real
// Strict session was `verifyGoal`'s LLM goal-check: the model deciding whether the model was finished.
// `JhEngine.Deps.taskComplete` is the engine's slot for a better answer, but it wants the EXPECTED
// OUTPUT and only a benchmark rig has that — so the production answer has to be a verifier that
// EXECUTES rather than one that knows, and the product already has one: the instance's provisioned
// quality commands (Settings → Quality, or auto-derived by the `quality_provision` tool), which the
// ordinary drain loop already runs as steers. Strict — the mode whose entire premise is verification —
// was the only place ignoring them.
//
// Scope, deliberately: only the WHOLE-PROJECT commands. `syntax` and `check` are per-file templates
// (`Quality.renderCommand` substitutes `{file}`) and answer a question about one edit, not about the
// deliverable. Order is cheapest-decisive first and it SHORT-CIRCUITS at the first failure, so the
// worst case is one full test suite per check rather than the whole battery.
export const COMPLETION_TYPECHECK_TIMEOUT = 120_000
export const COMPLETION_LINT_TIMEOUT = 120_000

export interface CompletionCheck {
  readonly label: "typecheck" | "test" | "lint"
  readonly command: string
  readonly timeoutMs: number
}

/** The whole-project quality commands, in gate order. Empty ⇒ this instance declared no verifier, and
 *  the engine keeps exactly its current behaviour (an absent gate is not a failing gate). */
export function completionChecks(quality: Quality.Config | undefined): ReadonlyArray<CompletionCheck> {
  if (quality === undefined || !quality.enabled) return []
  const out: CompletionCheck[] = []
  if (quality.commands.typecheck)
    out.push({ label: "typecheck", command: quality.commands.typecheck, timeoutMs: COMPLETION_TYPECHECK_TIMEOUT })
  if (quality.commands.test) out.push({ label: "test", command: quality.commands.test, timeoutMs: quality.testTimeout })
  if (quality.commands.lint)
    out.push({ label: "lint", command: quality.commands.lint, timeoutMs: COMPLETION_LINT_TIMEOUT })
  return out
}

/** Build the engine's `completionGate` over a runner. Never fails: a command that cannot even start
 *  (ENOENT) or times out is a RunResult like any other, and reads as NOT VERIFIED — the honest answer
 *  for a verifier that did not get to say yes (ruling 2). */
export function completionGateFor(
  runner: JhProcessRunner.Runner,
  checks: ReadonlyArray<CompletionCheck>,
  cwd: string,
): () => Effect.Effect<{ readonly ok: boolean; readonly detail: string }> {
  return () =>
    Effect.gen(function* () {
      for (const check of checks) {
        const r = yield* runner.run({ command: check.command, cwd, timeoutMs: check.timeoutMs })
        const ok = r.exitCode === 0 && !r.timedOut
        if (!ok)
          return {
            ok: false,
            // The product's own wording for a failed quality gate — one text, one stance ("does not
            // count as done until this passes"), whether the failure steers a normal turn or vetoes a
            // Strict completion.
            detail: Quality.failureMessage({
              label: check.label,
              command: check.command,
              output: r.output,
              ...(r.exitCode === undefined ? {} : { exit: r.exitCode }),
              ...(r.timedOut ? { timedOut: true } : {}),
            }),
          }
      }
      return { ok: true, detail: `this project's own checks pass (${checks.map((c) => c.label).join(", ")})` }
    })
}

// Milestones the user sees as chat notices. Leaf-level noise (every action/observation/verification)
// stays in the engine log; PHASE-level progress (root + its direct children) and every safety event
// surface. task_started is implicit in the opener the runner publishes.
const SAFETY_TYPES = new Set<JhLog.Entry["type"]>([
  "restored_best",
  "reverted",
  "rederived",
  "gate_yielded",
  "suspect_test",
  "coord_mode",
  "numerics_hint",
  "budget_note",
  // The completion gate is a SAFETY event by the same logic as `restored_best`: it is the harness
  // overriding what the model just claimed, and a user who is told "done" needs to see the thing that
  // decided it (or, on a refusal, why the run kept going).
  "completion_gate",
  "depth_degraded",
  "root_degraded",
  "split_degraded",
  "task_done",
  "task_blocked",
])
const PHASE_TYPES = new Set<JhLog.Entry["type"]>(["expanded", "committed", "committed_best_effort"])
const isPhaseLevel = (step: string | undefined): boolean => step !== undefined && /^root(\.\d+)?$/.test(step)

/** The one-line notice for a log entry, or undefined when it is leaf-level noise. */
export function milestone(entry: JhLog.Sequenced): string | undefined {
  const step = "step" in entry ? String((entry as { step?: unknown }).step ?? "") : undefined
  if (SAFETY_TYPES.has(entry.type) || (PHASE_TYPES.has(entry.type) && isPhaseLevel(step)))
    return JhLog.render([entry]).replace(/^\[\d+\] /, "")
  return undefined
}

/** The task = the newest real user message (harness steers carry the provenance prefix and never
 *  define a Strict task). */
export function lastUserText(context: readonly SessionMessage.Message[]): string | undefined {
  for (let i = context.length - 1; i >= 0; i--) {
    const message = context[i]!
    if (message.type !== "user") continue
    if (message.text.startsWith(SessionInput.STEER_PROVENANCE_PREFIX)) continue
    const text = message.text.trim()
    if (text) return text
  }
  return undefined
}

/** Generic execution-environment knowledge (jh.md §13.3) — shell mechanics only, never task content.
 *
 *  ⚠️ Takes the SHELL, not just the platform. It used to hardcode "Windows cmd.exe" from the
 *  platform alone, which was a lie on every Windows install that has bash (the provisioned bundle or
 *  a system git-bash) — the engine then coached the model in `set PATH=…;%PATH% &&` while the
 *  recipes it was cooking spoke POSIX. Strict now runs the SAME shell the `bash` tool runs
 *  (`Shell.agentDefault()`), and this text follows it. */
export function environmentFor(platform: NodeJS.Platform, shellPath: string = Shell.agentDefault()): string {
  const isBash = Shell.name(shellPath) === "bash"
  const shell = isBash
    ? `Each \`run\` command executes in a FRESH bash shell (\`${shellPath}\`) in the working directory; no PATH/cwd state persists between calls. Use POSIX syntax and FORWARD SLASHES \`/\` in ALL paths${platform === "win32" ? " (a Windows drive is `/c/...` to this bash)" : ""}. APPEND any needed directory inside the same command: \`PATH="$PATH:/dir/bin" your-command\` — PREPENDING a toolchain shadows the shell's own \`ls\`/\`head\`/\`cat\` and breaks later commands. Run a locally built program as \`./name\`. Reference files by relative path.`
    : platform === "win32"
      ? "Each `run` command executes in a FRESH Windows cmd.exe shell in the working directory. NO state (current directory, environment variables, PATH) persists between separate `run` calls. Use FORWARD SLASHES `/` in ALL paths. If a command needs a tool's directory on PATH, set it INSIDE that same command: `set PATH=C:/some/dir/bin;%PATH% && your-command`. A program built in the working directory must be run as `.\\name.exe` — a bare name fails. POSIX syntax (pipes into `head`, `2>/dev/null`, `VAR=x cmd`) does NOT work here. Reference files by relative path."
      : "Each `run` command executes in a FRESH /bin/sh shell in the working directory; no PATH/cwd state persists between calls. Prepend any needed PATH inside the command: `PATH=/dir/bin:$PATH your-command`. Run a locally built program as `./name`. Reference files by relative path."
  const guidance =
    "Work in SMALL VERIFIED STEPS: plan the TOP-LEVEL phases only (2-3 one-sentence phases, no nested sub-steps); each phase decomposes itself when you reach it. A step that can be verified by COMPILING or RUNNING something must be.\n" +
    "BUILD INCREMENTALLY WITH SURGICAL EDITS. Use `write_file` ONLY to create a NEW file. To CHANGE an existing file, prefer `replace_lines` (address the `N→` line numbers shown in the workspace) or `edit_file` for a short unique snippet; NEVER re-emit a whole file.\n" +
    "When a command fails, READ its diagnostics and fix the SPECIFIC thing they name, then re-verify."
  return `${shell}\n\n${guidance}`
}

/** Bounded, non-recursive workspace listing with binary placeholders (the harness listFiles, hardened
 *  for a real project directory). */
export function listFilesFor(cwd: string): ReadonlyArray<{ readonly name: string; readonly content: string }> {
  try {
    const entries = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => {
        const full = path.join(cwd, e.name)
        let mtimeMs = 0
        let size = 0
        try {
          const st = fs.statSync(full)
          mtimeMs = Math.round(st.mtimeMs)
          size = st.size
        } catch {}
        return { name: e.name, full, mtimeMs, size }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const shown = entries.slice(0, FILE_LIST_CAP)
    const files = shown.map((e) => {
      if (BINARY_EXTS.has(path.extname(e.name).toLowerCase()))
        // R1: the placeholder must CHANGE when the binary is rebuilt (staleness hashes name+content).
        return { name: e.name, content: `<compiled binary — ${e.size} bytes, mtime ${e.mtimeMs} (build succeeded)>` }
      try {
        return { name: e.name, content: fs.readFileSync(e.full, "utf8") }
      } catch {
        return { name: e.name, content: "<unreadable>" }
      }
    })
    // No silent caps: the omission is named as a pseudo-entry (its name cannot collide with a file).
    if (entries.length > shown.length)
      files.push({
        name: `(+${entries.length - shown.length} more files not shown — name one to read it)`,
        content: "",
      })
    return files
  } catch {
    return []
  }
}

// ── best-of-N racing helpers (improve11 P5) ────────────────────────────────────────────────────
const walkFiles = (root: string): Array<{ rel: string; full: string; size: number }> => {
  const out: Array<{ rel: string; full: string; size: number }> = []
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue
      const full = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(full, r)
      else if (e.isFile()) {
        let size = 0
        try {
          size = fs.statSync(full).size
        } catch {}
        out.push({ rel: r, full, size })
      }
    }
  }
  walk(root, "")
  return out
}
const sha1 = (buf: Buffer): string => crypto.createHash("sha1").update(buf).digest("hex")

/** Content manifest of a workspace (rel path → sha1), .git excluded — the apply-back baseline. */
export function manifestFor(root: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const f of walkFiles(root)) {
    try {
      m.set(f.rel, sha1(fs.readFileSync(f.full)))
    } catch {}
  }
  return m
}

/** How long a kept-for-inspection attempt workspace survives before the next race sweeps it. */
export const FORK_RETENTION_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Delete `jh-attempt*` workspaces in the temp dir older than the retention window.
 *
 * A race that nobody wins keeps its forks DELIBERATELY (the terminal notice names them so a user can
 * look at what the racers built), but nothing ever removed them: measured 2026-07-26, this laptop
 * had **325** stale `jh-attempt*` directories left by failed races and unit tests. "Kept for
 * inspection" only means anything for a few days; after that it is litter in the user's temp dir.
 * Best-effort and never throws — a sweep failure must not affect the run.
 */
export function sweepStaleForks(now: number = Date.now(), retentionMs: number = FORK_RETENTION_MS): number {
  let removed = 0
  let entries: string[]
  try {
    entries = fs.readdirSync(os.tmpdir())
  } catch {
    return 0
  }
  for (const name of entries) {
    if (!name.startsWith("jh-attempt")) continue
    const full = path.join(os.tmpdir(), name)
    try {
      const st = fs.statSync(full)
      if (!st.isDirectory() || now - st.mtimeMs < retentionMs) continue
      fs.rmSync(full, { recursive: true, force: true })
      removed++
    } catch {}
  }
  return removed
}

/** Fork the workspace into an isolated temp copy (bounded — L2: racers never touch the live folder).
 *  Returns the fork path, or the reason racing cannot fork (the caller degrades to one attempt). */
export function forkWorkspace(src: string, attempt: number): { readonly dir: string } | { readonly refused: string } {
  if (attempt === 1) sweepStaleForks()
  const files = walkFiles(src)
  const bytes = files.reduce((a, f) => a + f.size, 0)
  if (files.length > MAX_FORK_FILES)
    return { refused: `the folder has ${files.length} files (racing forks are capped at ${MAX_FORK_FILES})` }
  if (bytes > MAX_FORK_BYTES)
    return {
      refused: `the folder is ${(bytes / 1e6).toFixed(0)} MB (racing forks are capped at ${MAX_FORK_BYTES / 1e6} MB)`,
    }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jh-attempt${attempt}-`))
  fs.cpSync(src, dir, { recursive: true, filter: (p) => path.basename(p) !== ".git" })
  return { dir }
}

/** Apply the WINNER's changes back onto the live folder: files that differ from the fork-time
 *  manifest (or are new) are copied over; deletions are NOT propagated (v1 — safer for user data).
 *  Returns the applied rel paths. */
export function applyBack(winnerDir: string, dst: string, baseline: ReadonlyMap<string, string>): string[] {
  const applied: string[] = []
  for (const f of walkFiles(winnerDir)) {
    let content: Buffer
    try {
      content = fs.readFileSync(f.full)
    } catch {
      continue
    }
    if (baseline.get(f.rel) === sha1(content)) continue // unchanged since the fork
    const target = path.join(dst, f.rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
    applied.push(f.rel)
  }
  return applied
}

// P14.1 materialization (legibility half): the engine actions surfaced as chat tool parts. Only
// STATE-CHANGING actions + commands appear — reads/listings are engine working-set noise. The
// executor SWAP onto registry tools stays deferred (the engine's measured behavior rides its own
// tool semantics: tx gate, numbered workspace, fresh-shell run).
const MATERIALIZED_TOOLS = new Set(["run", "write_file", "append_file", "edit_file", "replace_lines", "git_revert"])
export const ACTION_ARG_CAP = 2_000
export const ACTION_OUTPUT_CAP = 4_000
/** Racing buffers each racer's actions so the winner's can be replayed onto the run message post-race.
 *  Cap the buffer per racer so a long grind can't grow it unbounded — oldest dropped, the recent tail
 *  is what a user actually reads. */
export const MATERIALIZED_ACTION_CAP = 500

export interface MaterializedAction {
  readonly tool: string
  /** Argument values truncated at capture — a whole written file must not flood the transcript. */
  readonly args: Record<string, unknown>
  readonly ok: boolean
  readonly output: string
}

const truncate = (text: string, cap: number) =>
  text.length > cap ? `${text.slice(0, cap)}\n… (${text.length - cap} more chars)` : text

/** Executor decorator: report each completed state-changing action (post-hoc — an aborted run can
 *  never leave a dangling unsettled part). Reporting failures never break the engine. */
export function materializingExecutor(
  executor: JhBasicTools.Executor,
  onAction: (action: MaterializedAction) => Effect.Effect<void>,
): JhBasicTools.Executor {
  return {
    run: (input) =>
      executor.run(input).pipe(
        Effect.tap((observation) => {
          if (!MATERIALIZED_TOOLS.has(input.tool)) return Effect.void
          const args: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(input.args ?? {}))
            args[key] = typeof value === "string" ? truncate(value, ACTION_ARG_CAP) : value
          return onAction({
            tool: input.tool,
            args,
            ok: observation.ok,
            output: truncate(observation.output, ACTION_OUTPUT_CAP),
          }).pipe(Effect.ignore)
        }),
      ),
  }
}

/** A resumed tree must be WORKABLE. A Stop (and some walls) lands while a node is in flight and
 *  the terminal path leaves it — often the ROOT itself — status "blocked"; resuming that state
 *  verbatim gives the engine nothing pending and it exits `no_progress` immediately (measured:
 *  a run stopped mid-decomposition saved `root: blocked`, and "resume" blocked in one step).
 *  Revive: every blocked node returns to pending so the engine re-attempts it under its normal
 *  guards; committed work is never touched (never redone). */
export function reviveForResume(state: JhEngine.State): JhEngine.State {
  let changed = false
  const nodes = new Map(state.tree.nodes)
  for (const [id, node] of nodes)
    if (node.status === "blocked") {
      nodes.set(id, { ...node, status: "pending" })
      changed = true
    }
  return changed ? { ...state, tree: { ...state.tree, nodes } } : state
}

export interface RunArgs {
  readonly task: string
  readonly cwd: string
  readonly strict: ConfigStrict.Info
  /** One system+user completion → the model's raw text (the runner's judgeCompletion idiom).
   *  `maxTokens` is per-CALL: reasoning and execution steps are budgeted separately (ConfigStrict). */
  readonly completeOnce: (system: string, user: string, maxTokens: number) => Effect.Effect<string, JhEngine.LLMFail>
  /** Publishes one progress notice into the chat (Synthetic). Batched milestone lines arrive joined. */
  readonly onMilestone: (text: string) => Effect.Effect<void>
  readonly checkpoint?: (state: JhEngine.State) => Effect.Effect<void>
  /** improve11 P5: the racing latch — a losing racer stops at its next step boundary. P14.1: also
   *  the user's Stop — the engine exits THROUGH the terminal best-restore at the next boundary. */
  readonly aborted?: () => boolean
  /** P14.1 resume: a JhStore-checkpointed state to continue from (crash/stop recovery). The engine
   *  picks up the existing tree instead of re-planning; completed steps are never redone. */
  readonly resume?: JhEngine.State
  /** P14.1 materialization: called after each completed state-changing engine action — the runner
   *  publishes it as a chat tool part (single attempts), or buffers it to replay the WINNER's after
   *  the race (racing). Post-hoc + best-effort; unset = no materialization. */
  readonly onAction?: (action: MaterializedAction) => Effect.Effect<void>
  /**
   * The host-execution context for every command this run executes (ruling 6, `src/host-exec.ts`).
   * Only the session runner can know these — the chain-ROOT session type, whether an untrusted
   * messenger chat drives the turn, the operator's configured shell, and the live offline policy —
   * so they are injected here rather than re-derived.
   *
   * ⚠️ When it is omitted the run still executes, and still gets the CREDENTIAL half of the gate:
   * every command starts from the curated, secret-free environment, because a harness command is
   * never approved by a human (`consent: "none"`). The CONFINEMENT half cannot engage without a
   * declared root type — the gate will not invent an attendance nobody told it — so commands run
   * raw. `session/runner/llm.ts` must pass this for an unattended Strict chain (a Calendar fire, a
   * messenger dispatch) to be confined or denied the way the `bash` tool already is.
   */
  readonly host?: HostExec.SessionHost
  /**
   * The instance's quality configuration (`Settings → Quality`, the same block the normal drain loop
   * runs as steers). Supplies the COMPLETION GATE: with whole-project commands configured, a Strict run
   * cannot report the task complete until they actually pass. Omitted, or configured with no
   * whole-project command, and completion stays exactly as it is today — the model's own goal-check.
   *
   * ⚠️ Only `session/runner/llm.ts` can resolve this (it is per-session, on the resolved harness
   * config), so it is injected here for the same reason `host` is.
   */
  readonly quality?: Quality.Config
  readonly now?: () => number
}

/**
 * The host-execution plan for ONE harness command — every command a Strict run executes goes
 * through here, and it is EXPORTED so the wiring is checkable without standing up an engine run.
 *
 * Two halves, both owned by the gate (`src/host-exec.ts`, ruling 6):
 *  · CREDENTIALS — `consent: "none"`, unconditionally. The engine writes these commands and runs
 *    them; no human approved any of them, so the child never inherits the serve process's
 *    environment (it used to get `{ ...process.env }`: provider API keys and peer instance tokens).
 *  · CONFINEMENT — only as strong as what the caller DECLARED. With no `host` the gate is not told
 *    an attendance and runs raw; with one, an unattended chain is bwrap-confined where a backend
 *    exists and DENIED where none does, exactly like `tool/bash.ts`.
 */
export function commandPlan(input: {
  readonly command: string
  readonly cwd: string
  readonly shell: string
  /** The MSYS-bash userland PATH prefix, resolved once per run by the caller. */
  readonly overlay?: Record<string, string> | undefined
  readonly host?: HostExec.SessionHost
}): HostExec.SpawnPlan {
  return HostExec.spawnPlan({
    shape: { kind: "shell-command", shell: input.shell, command: input.command },
    cwd: input.cwd,
    // The blast radius of a Strict run is the folder it works in: the session's location, or —
    // when racing — this racer's isolated fork, which lives OUTSIDE the location (in tmp), so
    // the location would be the wrong bind.
    worktree: input.cwd,
    // No human approves a harness command: the engine writes them and runs them.
    consent: "none",
    rootType: input.host?.rootType,
    hostileInput: input.host?.hostileInput,
    backend: input.host?.backend,
    // The per-session SAFE MODE switch (owner 2026-07-30). Forwarded for the same reason every
    // other field here is: the gate decides nothing it was not told, and a field the runner holds
    // but does not pass is a switch the user ticked that silently governs `bash` and not Strict —
    // which is precisely the per-call-site divergence ruling 6 exists to prevent.
    safeMode: input.host?.safeMode,
    overlay: input.overlay,
    egress: input.host?.egress,
  })
}

/** Run one Strict task over the session's working directory. Milestones buffer synchronously (onLog is
 *  sync) and flush before each model call and at the end — bounded staleness, one notice per batch. */
export function runTask(args: RunArgs): Effect.Effect<JhEngine.Report> {
  const nowFn = args.now ?? (() => Date.now())
  // ONE shell for the whole product, resolved by the ONE host-execution gate: `config.shell` when
  // the operator set one, else the agent default (bundled PortableGit / system git-bash / COMSPEC).
  // A Strict run and a normal turn on the same host must not speak different shells — half of the
  // COMSPEC divergence was exactly that Strict ignored `config.shell` while `tool/bash.ts` honoured
  // it. `environmentFor` below follows this value, so what the model is TOLD tracks what runs.
  const agentShell = HostExec.resolveShell(args.host?.shell)
  // `bash -c` is not a login shell, so an MSYS bash needs its own userland prepended or `ls`/`head`
  // don't resolve (no-op for non-MSYS shells).
  const shellEnv = HostExec.bundleOverlay(agentShell)
  // Every command the engine runs goes through the gate: the jail decision (raw / bwrap-confined /
  // denied), and an environment that NEVER contains the serve process's secrets. It used to be
  // `{ ...process.env }` — provider API keys and `NOVACLAW_INSTANCE_*_TOKEN` handed to arbitrary
  // model-authored commands, with no human approving any of them.
  const runner = JhProcessRunner.plannedRunner({
    plan: (input) =>
      commandPlan({
        command: input.command,
        cwd: input.cwd,
        shell: agentShell,
        overlay: shellEnv,
        ...(args.host === undefined ? {} : { host: args.host }),
      }),
  })
  // The completion gate's commands, resolved once: they run through the SAME planned runner as every
  // other harness command, so `bun test` in a Strict run is jailed, secret-free and shell-consistent
  // exactly like a `run` atom (ruling 6 — there is one host-execution gate, not one per call site).
  const gateChecks = completionChecks(args.quality)
  const wallMin =
    args.strict.wallMinutes !== undefined && args.strict.wallMinutes > 0 ? args.strict.wallMinutes : WALL_DEFAULT_MIN
  const queue: string[] = []
  const flush: Effect.Effect<void> = Effect.suspend(() => {
    if (queue.length === 0) return Effect.void
    const text = queue.splice(0, queue.length).join("\n")
    return args.onMilestone(text)
  })
  // Per-call budgets (ConfigStrict). Execution truncation is fatal (a half-written source file);
  // reasoning truncation returns EMPTY, because a <think> block that never closes leaves the parser
  // nothing to extract — so the reasoning stage is either budgeted generously or left off entirely.
  const execTokens = positive(args.strict.executionTokens) ?? EXECUTION_TOKENS_DEFAULT
  const reasonTokens = positive(args.strict.reasoningTokens)
  const withFlush =
    (maxTokens: number) =>
    (p: { readonly system: string; readonly user: string }): Effect.Effect<string, JhEngine.LLMFail> =>
      flush.pipe(Effect.andThen(args.completeOnce(p.system, p.user, maxTokens)))
  const deps: JhEngine.Deps = {
    introspect: withFlush(execTokens),
    correct: withFlush(execTokens),
    // The THINK/DO split (notes/jh-think-stage.md): opt-in via a non-zero reasoning budget, and
    // scoped to the steps the wall actually goes to — decomposition and recovery, not every atom.
    ...(reasonTokens !== undefined ? { think: withFlush(reasonTokens), thinkOn: THINK_ON } : {}),
    executor:
      args.onAction === undefined
        ? JhBasicTools.basicExecutor(runner)
        : materializingExecutor(JhBasicTools.basicExecutor(runner), args.onAction),
    runner,
    artifacts: JhArtifact.memory(),
    fileExists: (rel, base) => fs.existsSync(path.isAbsolute(rel) ? rel : path.join(base, rel)),
    cwd: args.cwd,
    environment: environmentFor(process.platform, agentShell),
    forceRootDecompose: true,
    verifyGoal: true,
    listFiles: () => listFilesFor(args.cwd),
    // No git checkpoints in a USER project (L3) — git_revert would fail confusingly; drop the atom.
    toolNames: JhBasicTools.TOOL_NAMES.filter((t) => t !== "git_revert"),
    limits: { maxDepth: MAX_DEPTH, maxTotalSteps: MAX_TOTAL_STEPS },
    trigger: JhBudget.DEFAULT_TRIGGER,
    budget: { startedAt: nowFn(), wallMs: wallMin * 60 * 1000, now: nowFn },
    ...flagsFor(args.strict),
    // The mechanical whole-task veto. Absent when this instance provisioned no whole-project quality
    // command — an instance with no verifier gets no fake one (ruling 2 cuts both ways: we neither
    // claim a verification we did not do, nor block a run on a check nobody configured).
    ...(gateChecks.length === 0 ? {} : { completionGate: completionGateFor(runner, gateChecks, args.cwd) }),
    aborted: args.aborted,
    checkpoint: args.checkpoint,
    onLog: (entry) => {
      const line = milestone(entry)
      if (line) queue.push(line)
    },
  }
  return Effect.gen(function* () {
    const report = yield* JhEngine.runTask(deps, { goal: args.task }, args.resume && reviveForResume(args.resume))
    yield* flush
    return report
  })
}
