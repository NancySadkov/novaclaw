export * as JhBasicTools from "./tools-basic"

// jh — the curated v0 executor atoms (D14): write_file · read_file · run · note. These are jh-local,
// NOT the core ToolRegistry (that mapping is Phase 14). Every path is sandboxed under cwd (absolute or
// `..` paths are refused as an observation, never a throw). Like the runner, the executor NEVER fails:
// an unknown tool, bad args, or an fs error all become an ok:false Observation (the spawn-tool
// denial-as-observation pattern), so the engine treats them as retryable data (jh.md §12).

import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import type { JhStep } from "./step"
import type { JhProcessRunner } from "./process-runner"

export interface Observation {
  readonly ok: boolean
  readonly output: string
  /** contents for the step's declared produces, keyed by artifact id. */
  readonly artifacts: ReadonlyMap<string, string>
}

export interface Executor {
  readonly run: (input: {
    readonly tool: string
    readonly args: Readonly<Record<string, unknown>>
    readonly produces: ReadonlyArray<JhStep.ArtifactRef>
    readonly cwd: string
  }) => Effect.Effect<Observation>
}

export const TOOL_NAMES: ReadonlyArray<string> = ["write_file", "append_file", "edit_file", "replace_lines", "read_file", "run", "note", "git_revert"]

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const noArtifacts: ReadonlyMap<string, string> = new Map()
const obs = (ok: boolean, output: string, artifacts: ReadonlyMap<string, string> = noArtifacts): Observation => ({ ok, output, artifacts })
const badArgs = (tool: string, shape: string): Observation => obs(false, `${tool} expects ${shape}`)

/** Resolve a relative path under cwd, refusing absolute paths and `..` escapes. */
function safePath(cwd: string, rel: string): string | undefined {
  if (path.isAbsolute(rel)) return undefined
  if (rel.split(/[\\/]/).includes("..")) return undefined
  const target = path.resolve(cwd, rel)
  return target.startsWith(path.resolve(cwd)) ? target : undefined
}

/** The first declared produce matching `pred` receives the tool's principal content. */
function assignFirst(produces: ReadonlyArray<JhStep.ArtifactRef>, pred: (r: JhStep.ArtifactRef) => boolean, content: string): ReadonlyMap<string, string> {
  const ref = produces.find(pred)
  return ref ? new Map([[ref.id, content]]) : noArtifacts
}

function writeFile(input: { args: Readonly<Record<string, unknown>>; produces: ReadonlyArray<JhStep.ArtifactRef>; cwd: string }): Observation {
  const { path: p, content } = input.args
  if (typeof p !== "string" || typeof content !== "string") return badArgs("write_file", "{path: string, content: string}")
  const target = safePath(input.cwd, p)
  if (!target) return obs(false, `write_file refused unsafe path "${p}" (absolute or contains "..")`)
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, "utf8")
  } catch (e) {
    return obs(false, `write_file failed: ${messageOf(e)}`)
  }
  return obs(true, `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`, assignFirst(input.produces, (r) => r.type === "file", content))
}

// improve17 L2 (the beat-run pipeline): bulk artifacts (chapters, long documents) GROW in verified
// increments — appending must not re-transmit the file (whole-chapter regeneration was the #1 wall
// sink in the Tier-3 batteries: every gate failure re-bought a ~2,700-token generation). Creates the
// file when missing; separates increments with a blank line when the existing text doesn't already
// end in one (the natural paragraph glue for prose — and harmless for code/logs).
function appendFile(input: { args: Readonly<Record<string, unknown>>; produces: ReadonlyArray<JhStep.ArtifactRef>; cwd: string }): Observation {
  const { path: p, content } = input.args
  if (typeof p !== "string" || typeof content !== "string") return badArgs("append_file", "{path: string, content: string}")
  if (content === "") return obs(false, "append_file: content is empty — nothing to append")
  const target = safePath(input.cwd, p)
  if (!target) return obs(false, `append_file refused unsafe path "${p}" (absolute or contains "..")`)
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    let existing = ""
    try {
      existing = fs.readFileSync(target, "utf8")
    } catch {}
    const glue = existing === "" ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n"
    const updated = existing + glue + content
    fs.writeFileSync(target, updated, "utf8")
    return obs(
      true,
      `appended ${Buffer.byteLength(content, "utf8")} bytes to ${p} (file is now ${updated.split("\n").length} lines)`,
      assignFirst(input.produces, (r) => r.type === "file", updated),
    )
  } catch (e) {
    return obs(false, `append_file failed: ${messageOf(e)}`)
  }
}

// improve3 P4 (C7/R-EDIT): a weak model quotes old_string with CRLF/trailing-space/indent drift, so an
// EXACT-only match fails constantly (run54: 29× "old_string not found" on a SUCCESS run). Three tiers:
// (0) exact; (1) CRLF + trailing-whitespace-normalized; (2) leading-indentation-flex (per-line ltrim).
// Uniqueness is enforced at whichever tier first yields ≥1 match. A line-based match REPLACES the raw content
// lines (so tier 1/2 heal the quote without corrupting the rest). Returns the updated content + the tier used.
const normLine = (l: string, tier: number): string => {
  let x = l.replace(/\r$/, "").replace(/[ \t]+$/, "") // tier 1: CRLF + trailing whitespace
  if (tier >= 2) x = x.replace(/^[ \t]+/, "") // tier 2: leading indentation
  if (tier >= 3) x = x.replace(/\s+/g, " ").trim() // improve5 P1d tier 3: collapse ALL internal whitespace runs
  return x
}
type EditMatch = { readonly kind: "ok"; readonly updated: string; readonly tier: number } | { readonly kind: "multi"; readonly count: number; readonly tier: number } | { readonly kind: "miss" }
function matchEdit(content: string, oldStr: string, newStr: string): EditMatch {
  if (oldStr === "") return { kind: "miss" }
  // Tier 0: exact.
  const exact = content.split(oldStr).length - 1
  if (exact === 1) return { kind: "ok", updated: content.replace(oldStr, newStr), tier: 0 }
  if (exact > 1) return { kind: "multi", count: exact, tier: 0 }
  // Tiers 1 & 2: line-based normalized (whole-line windows).
  const cLines = content.split("\n")
  const oLines = oldStr.split("\n")
  for (const tier of [1, 2, 3]) {
    const cn = cLines.map((l) => normLine(l, tier))
    const on = oLines.map((l) => normLine(l, tier))
    const k = on.length
    const at: number[] = []
    for (let i = 0; i + k <= cn.length; i++) {
      let hit = true
      for (let j = 0; j < k; j++)
        if (cn[i + j] !== on[j]) {
          hit = false
          break
        }
      if (hit) at.push(i)
    }
    if (at.length === 1) {
      const i = at[0]!
      const updated = [...cLines.slice(0, i), ...newStr.split("\n"), ...cLines.slice(i + k)].join("\n")
      return { kind: "ok", updated, tier }
    }
    if (at.length > 1) return { kind: "multi", count: at.length, tier }
  }
  return { kind: "miss" }
}
/** On a total miss, name the file line most similar to old_string's first line (shared-prefix + containment
 *  ranking — no full Levenshtein) so the model can re-quote it exactly. */
function nearestLine(content: string, oldStr: string): string {
  const target = (oldStr.split("\n")[0] ?? "").trim()
  if (target === "") return ""
  const commonPrefix = (a: string, b: string): number => {
    let n = 0
    while (n < a.length && n < b.length && a[n] === b[n]) n++
    return n
  }
  let best = ""
  let bestScore = -1
  for (const l of content.split("\n")) {
    const t = l.trim()
    if (t === "") continue
    const score = commonPrefix(t, target) + (t.includes(target) || target.includes(t) ? 1000 : 0)
    if (score > bestScore) {
      bestScore = score
      best = t
    }
  }
  return best
}

// R5 (jh-improve1): a TARGETED edit — replace ONE unique occurrence of old_string. ~10× fewer output tokens
// than a whole-file rewrite and can't corrupt the untouched rest of the file (kills D5). improve3 P4 adds the
// near-miss tiers above so weak-model quote drift heals instead of looping.
function editFile(input: { args: Readonly<Record<string, unknown>>; produces: ReadonlyArray<JhStep.ArtifactRef>; cwd: string }): Observation {
  const { path: p, old_string: oldStr, new_string: newStr } = input.args
  if (typeof p !== "string" || typeof oldStr !== "string" || typeof newStr !== "string") return badArgs("edit_file", "{path: string, old_string: string, new_string: string}")
  const target = safePath(input.cwd, p)
  if (!target) return obs(false, `edit_file refused unsafe path "${p}" (absolute or contains "..")`)
  let content: string
  try {
    content = fs.readFileSync(target, "utf8")
  } catch {
    let present = ""
    try {
      present = fs.readdirSync(input.cwd).join(", ")
    } catch {}
    return obs(false, `file not found: ${p} — files present: ${present}`)
  }
  const m = matchEdit(content, oldStr, newStr)
  if (m.kind === "multi") return obs(false, `old_string occurs ${m.count} times in ${p} — provide a longer, UNIQUE snippet so exactly one match is edited`)
  if (m.kind === "miss") {
    const near = nearestLine(content, oldStr)
    const hint = near ? ` The nearest line in the file is: '${near}' — copy it EXACTLY (including indentation).` : ""
    return obs(false, `old_string not found in ${p} — the file's ACTUAL current content is shown in the context above; copy the exact text to replace.${hint}`)
  }
  try {
    fs.writeFileSync(target, m.updated, "utf8")
  } catch (e) {
    return obs(false, `edit_file failed: ${messageOf(e)}`)
  }
  const note = m.tier > 0 ? ` (matched with ${m.tier === 1 ? "whitespace" : m.tier === 2 ? "indentation" : "whitespace-collapsed"} normalization)` : ""
  return obs(true, `edited ${p}: -${oldStr.length} +${newStr.length} chars${note}`, assignFirst(input.produces, (r) => r.type === "file", m.updated))
}

// improve5 P1c: coordinate-addressed editing — replace an INCLUSIVE 1-based line range with new content. A
// weak model cannot reliably reproduce an exact byte sequence (edit_file's `old_string` missed 16–77×/run in
// wave 4), but it CAN read the `N→` line numbers shown in the workspace and name a range. Replace-only
// (first_line ≤ last_line ≤ line count); out-of-range names the file's actual length; the observation ECHOES
// the replaced lines so a mis-target is immediately visible + git/tx-revertible. Sandboxed like write_file.
function replaceLines(input: { args: Readonly<Record<string, unknown>>; produces: ReadonlyArray<JhStep.ArtifactRef>; cwd: string }): Observation {
  const { path: p, first_line: first, last_line: last, new_content: repl } = input.args
  if (typeof p !== "string" || typeof first !== "number" || typeof last !== "number" || typeof repl !== "string")
    return badArgs("replace_lines", "{path: string, first_line: number, last_line: number, new_content: string}")
  if (!Number.isInteger(first) || !Number.isInteger(last)) return obs(false, "replace_lines: first_line and last_line must be integers")
  const target = safePath(input.cwd, p)
  if (!target) return obs(false, `replace_lines refused unsafe path "${p}" (absolute or contains "..")`)
  let content: string
  try {
    content = fs.readFileSync(target, "utf8")
  } catch {
    return obs(false, `file not found: ${p} — use write_file to create it first`)
  }
  const lines = content.split("\n")
  const n = lines.length
  if (first < 1 || last < first || last > n)
    return obs(false, `replace_lines out of range: ${p} has ${n} lines; you gave first_line=${first} last_line=${last} (need 1 ≤ first_line ≤ last_line ≤ ${n}). The workspace listing shows the current line numbers.`)
  const removed = lines.slice(first - 1, last).join("\n")
  const updated = [...lines.slice(0, first - 1), ...repl.split("\n"), ...lines.slice(last)].join("\n")
  try {
    fs.writeFileSync(target, updated, "utf8")
  } catch (e) {
    return obs(false, `replace_lines failed: ${messageOf(e)}`)
  }
  const echo = removed.length > 240 ? removed.slice(0, 240) + "…" : removed
  return obs(true, `replaced lines ${first}-${last} in ${p} (was: ${JSON.stringify(echo)})`, assignFirst(input.produces, (r) => r.type === "file", updated))
}

function readFile(input: { args: Readonly<Record<string, unknown>>; produces: ReadonlyArray<JhStep.ArtifactRef>; cwd: string }): Observation {
  const { path: p } = input.args
  if (typeof p !== "string") return badArgs("read_file", "{path: string}")
  const target = safePath(input.cwd, p)
  if (!target) return obs(false, `read_file refused unsafe path "${p}"`)
  try {
    let content = fs.readFileSync(target, "utf8")
    if (content.length > 65_536) content = content.slice(0, 65_536) + "…[truncated]"
    return obs(true, content, assignFirst(input.produces, () => true, content))
  } catch (e) {
    return obs(false, `read_file failed: ${messageOf(e)}`)
  }
}

function note(input: { args: Readonly<Record<string, unknown>>; produces: ReadonlyArray<JhStep.ArtifactRef> }): Observation {
  const { text } = input.args
  if (typeof text !== "string") return badArgs("note", "{text: string}")
  return obs(true, text, assignFirst(input.produces, (r) => r.type === "note" || r.type === "text", text))
}

// jh-improve2: undo a botched, unfixable edit by rolling the file back to the last VERIFIED checkpoint (the
// harness commits after each verified step). `git checkout -- <path>` restores TRACKED files to HEAD; an
// untracked file (never checkpointed) can't be reverted this way — that's reported. Uses the runner (a git
// subprocess), like `run`. This is the surgical-edit safety net (owner: don't rewrite the whole program —
// edit; if the edit botches, revert and re-edit).
function gitRevert(runner: JhProcessRunner.Runner, input: { args: Readonly<Record<string, unknown>>; cwd: string }): Effect.Effect<Observation> {
  const raw = input.args.path
  const p = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : "."
  if (p !== "." && !safePath(input.cwd, p)) return Effect.succeed(obs(false, `git_revert refused unsafe path "${p}" (absolute or contains "..")`))
  return runner.run({ command: `git checkout -- ${p}`, cwd: input.cwd, timeoutMs: 15_000 }).pipe(
    Effect.map((r) =>
      obs(
        r.exitCode === 0 && !r.timedOut,
        r.exitCode === 0 && !r.timedOut
          ? `git_revert: rolled ${p === "." ? "the working tree" : p} back to the last verified checkpoint`
          : `git_revert failed (exit ${r.exitCode}): ${r.output.trim() || "the file may be untracked (never checkpointed) or this is not a git repo"}`,
      ),
    ),
  )
}

export function basicExecutor(runner: JhProcessRunner.Runner, opts?: { readonly runTimeoutMs?: number }): Executor {
  // C9: the run-action timeout is caller-tunable — for compute tasks a correct program finishes in
  // seconds, so a 60 s wait per hung run is pure wall loss (run57: 30 hung runs × 60 s ≈ half the wall).
  const runTimeoutMs = opts?.runTimeoutMs ?? 60_000
  return {
    run: (input) => {
      switch (input.tool) {
        case "write_file":
          return Effect.succeed(writeFile(input))
        case "append_file":
          return Effect.succeed(appendFile(input))
        case "edit_file":
          return Effect.succeed(editFile(input))
        case "replace_lines":
          return Effect.succeed(replaceLines(input))
        case "read_file":
          return Effect.succeed(readFile(input))
        case "note":
          return Effect.succeed(note(input))
        case "git_revert":
          return gitRevert(runner, input)
        case "run": {
          const command = input.args.command
          if (typeof command !== "string") return Effect.succeed(badArgs("run", "{command: string}"))
          return runner.run({ command, cwd: input.cwd, timeoutMs: runTimeoutMs }).pipe(
            Effect.map((r) =>
              obs(
                r.exitCode === 0 && !r.timedOut,
                r.timedOut
                  ? // C9: a bare "timed out" manufactures a fake opaque rut — name the likely cause + the fix.
                    `command timed out after ${runTimeoutMs}ms and was KILLED — your program did not terminate. If this command RUNS a program, that program most likely has an INFINITE LOOP (or reads input it never gets): add an iteration BOUND to every loop, print progress, recompile, and re-run.${r.output.trim() ? `\n${r.output}` : ""}`
                  : r.exitCode === 0
                    ? r.output
                    : // a non-zero exit with no output is a runtime CRASH — tell the model it's a source bug, not a
                      // command to re-run (else it re-runs the same crashing binary; iter 23).
                      `command exited with non-zero code ${r.exitCode}${r.output.trim() ? `\n${r.output}` : " and produced NO output — this is a runtime CRASH (a bug in the program's logic: out-of-bounds array, integer overflow, or a bad pointer). Fix the SOURCE code and recompile; do NOT just re-run the same binary."}`,
                assignFirst(input.produces, (ref) => ref.type === "command_output", r.output),
              ),
            ),
          )
        }
        default:
          return Effect.succeed(obs(false, `unknown tool "${input.tool}"; available: ${TOOL_NAMES.join(", ")}`))
      }
    },
  }
}
