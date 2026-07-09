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

export const TOOL_NAMES: ReadonlyArray<string> = ["write_file", "read_file", "run", "note"]

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

export function basicExecutor(runner: JhProcessRunner.Runner): Executor {
  return {
    run: (input) => {
      switch (input.tool) {
        case "write_file":
          return Effect.succeed(writeFile(input))
        case "read_file":
          return Effect.succeed(readFile(input))
        case "note":
          return Effect.succeed(note(input))
        case "run": {
          const command = input.args.command
          if (typeof command !== "string") return Effect.succeed(badArgs("run", "{command: string}"))
          return runner.run({ command, cwd: input.cwd, timeoutMs: 60_000 }).pipe(
            Effect.map((r) =>
              obs(
                r.exitCode === 0 && !r.timedOut,
                r.timedOut
                  ? `timed out\n${r.output}`
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
