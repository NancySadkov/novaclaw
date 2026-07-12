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
import fs from "node:fs"
import path from "node:path"
import { JhArtifact } from "../../jh/artifact"
import { JhBasicTools } from "../../jh/tools-basic"
import { JhBudget } from "../../jh/budget"
import { JhEngine } from "../../jh/engine"
import { JhLog } from "../../jh/log"
import { JhProcessRunner } from "../../jh/process-runner"
import type { ConfigStrict } from "../../config/strict"
import { SessionInput } from "../input"
import type { SessionMessage } from "../message"

export const WALL_DEFAULT_MIN = 45
export const MAX_DEPTH = 5
export const MAX_TOTAL_STEPS = 64
// The workspace render is the model's working set — a session cwd can be a whole user project, so the
// listing is bounded (most-recently-modified first; the tail entry names how many files were omitted).
export const FILE_LIST_CAP = 24
const BINARY_EXTS = new Set([".exe", ".o", ".obj", ".dll", ".so", ".dylib", ".bin", ".a", ".lib"])

/** ConfigStrict group toggles → engine lever flags. `undefined` = the engine's default (ON); an
 *  explicit group `false` disables its family (core/src/config/strict.ts documents the mapping). */
export function flagsFor(strict: ConfigStrict.Info): Pick<
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

/** Generic execution-environment knowledge (jh.md §13.3) — shell mechanics only, never task content. */
export function environmentFor(platform: NodeJS.Platform): string {
  const shell =
    platform === "win32"
      ? "Each `run` command executes in a FRESH Windows cmd.exe shell in the working directory. NO state (current directory, environment variables, PATH) persists between separate `run` calls. Use FORWARD SLASHES `/` in ALL paths. If a command needs a tool's directory on PATH, set it INSIDE that same command: `set PATH=C:/some/dir/bin;%PATH% && your-command`. A program built in the working directory must be run as `.\\name.exe` — a bare name fails. Reference files by relative path."
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
      files.push({ name: `(+${entries.length - shown.length} more files not shown — name one to read it)`, content: "" })
    return files
  } catch {
    return []
  }
}

export interface RunArgs {
  readonly task: string
  readonly cwd: string
  readonly strict: ConfigStrict.Info
  /** One system+user completion → the model's raw text (the runner's judgeCompletion idiom). */
  readonly completeOnce: (system: string, user: string) => Effect.Effect<string, JhEngine.LLMFail>
  /** Publishes one progress notice into the chat (Synthetic). Batched milestone lines arrive joined. */
  readonly onMilestone: (text: string) => Effect.Effect<void>
  readonly checkpoint?: (state: JhEngine.State) => Effect.Effect<void>
  readonly now?: () => number
}

/** Run one Strict task over the session's working directory. Milestones buffer synchronously (onLog is
 *  sync) and flush before each model call and at the end — bounded staleness, one notice per batch. */
export function runTask(args: RunArgs): Effect.Effect<JhEngine.Report> {
  const nowFn = args.now ?? (() => Date.now())
  const runner = JhProcessRunner.shellRunner()
  const wallMin = args.strict.wallMinutes !== undefined && args.strict.wallMinutes > 0 ? args.strict.wallMinutes : WALL_DEFAULT_MIN
  const queue: string[] = []
  const flush: Effect.Effect<void> = Effect.suspend(() => {
    if (queue.length === 0) return Effect.void
    const text = queue.splice(0, queue.length).join("\n")
    return args.onMilestone(text)
  })
  const withFlush = (fn: (system: string, user: string) => Effect.Effect<string, JhEngine.LLMFail>) =>
    (p: { readonly system: string; readonly user: string }): Effect.Effect<string, JhEngine.LLMFail> =>
      flush.pipe(Effect.andThen(fn(p.system, p.user)))
  const deps: JhEngine.Deps = {
    introspect: withFlush(args.completeOnce),
    correct: withFlush(args.completeOnce),
    executor: JhBasicTools.basicExecutor(runner),
    runner,
    artifacts: JhArtifact.memory(),
    fileExists: (rel, base) => fs.existsSync(path.isAbsolute(rel) ? rel : path.join(base, rel)),
    cwd: args.cwd,
    environment: environmentFor(process.platform),
    forceRootDecompose: true,
    verifyGoal: true,
    listFiles: () => listFilesFor(args.cwd),
    // No git checkpoints in a USER project (L3) — git_revert would fail confusingly; drop the atom.
    toolNames: JhBasicTools.TOOL_NAMES.filter((t) => t !== "git_revert"),
    limits: { maxDepth: MAX_DEPTH, maxTotalSteps: MAX_TOTAL_STEPS },
    trigger: JhBudget.DEFAULT_TRIGGER,
    budget: { startedAt: nowFn(), wallMs: wallMin * 60 * 1000, now: nowFn },
    ...flagsFor(args.strict),
    checkpoint: args.checkpoint,
    onLog: (entry) => {
      const line = milestone(entry)
      if (line) queue.push(line)
    },
  }
  return Effect.gen(function* () {
    const report = yield* JhEngine.runTask(deps, { goal: args.task })
    yield* flush
    return report
  })
}
