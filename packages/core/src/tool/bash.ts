export * as BashTool from "./bash"

import path from "path"
import { ToolFailure } from "@novaclaw/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { BashJobs } from "./bash-jobs"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024

export const Input = Schema.Struct({
  command: Schema.String.pipe(Schema.optional).annotate({
    description: "Shell command string to execute (omit when polling/controlling a job via `job`)",
  }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Soft deadline in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). A command that outlives it is NOT killed — it keeps running as a job and control returns to you. For \`action:"wait"\` this is how long to wait.`,
    }),
  job: Schema.String.pipe(Schema.optional).annotate({
    description: "A job id previously returned by this tool (a command that outlived its soft deadline)",
  }),
  action: Schema.Literals(["status", "wait", "stop"])
    .pipe(Schema.optional)
    .annotate({
      description: `With \`job\`: "status" (default) reports immediately; "wait" blocks up to \`timeout\` ms for completion; "stop" terminates the job.`,
    }),
})

const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
  job: Schema.String.pipe(Schema.optional),
  running: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

const modelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  const prefix = `${warnings.trimStart()}${warnings ? "\n\n" : ""}`
  if (output.running && output.job)
    return (
      `${prefix}Still running after the soft deadline — the command was NOT killed; it continues as job "${output.job}". ` +
      `The output above is a partial capture. Do not conclude from it. ` +
      `Continue other work, or check on it: {"job": "${output.job}"} for an instant status, ` +
      `{"job": "${output.job}", "action": "wait", "timeout": 30000} to block up to 30 s for completion, ` +
      `{"job": "${output.job}", "action": "stop"} to terminate it.`
    )
  if (output.job !== undefined && output.exit === undefined && !output.running)
    return `${prefix}Job ${output.job} stopped without an exit code.`
  return `${prefix}Command exited with code ${output.exit}.`
}

// 1H yield text: teach the recovery, never let "timeout" read as failure (1P house style).
const jobSnapshotOutput = (job: BashJobs.Snapshot): Output => ({
  output: job.output || "(no output yet)",
  truncated: job.truncated,
  job: job.id,
  running: job.running,
  ...(job.exit !== undefined ? { exit: job.exit } : {}),
})

/**
 * Minimal V2 core shell boundary. Keep parity debt visible without pulling the
 * legacy shell runtime into core.
 */
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery.
// TODO: Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.
// TODO: Stream full shell output into managed storage while retaining only a bounded in-memory preview.

const shellTokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")
const externalCommandDirectories = (command: string, cwd: string) => {
  const directories = new Set<string>()
  for (const token of shellTokens(command)) {
    const value = unquote(token).replace(/[;,|&]+$/, "")
    if (!path.isAbsolute(value)) continue
    const resolved = FSUtil.resolve(value)
    if (FSUtil.contains(cwd, resolved)) continue
    directories.add(FSUtil.resolve(path.dirname(resolved)))
  }
  return [...directories]
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const bashJobs = yield* BashJobs.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. Prefer the dedicated \`read\`/\`edit\`/\`glob\`/\`grep\` tools over cat/sed/find/grep — they page and report limits safely. Output is capped at ${Math.round(MAX_CAPTURE_BYTES / 1024 / 1024)} MB: when the result says it was truncated, do not conclude from the missing span — re-run narrower (grep/head/tail). The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. The timeout is a SOFT deadline in milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}): a command that outlives it is NOT killed — it keeps running as a job and you get its id plus output-so-far; poll with {"job": "<id>"}, block with {"job": "<id>", "action": "wait", "timeout": 30000}, or terminate with {"job": "<id>", "action": "stop"}. Never re-run a command that yielded to a job — poll the job instead. Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows.`,
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            truncated: output.truncated,
            ...(output.exit === undefined ? {} : { exit: output.exit }),
            ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
            ...(output.job === undefined ? {} : { job: output.job }),
            ...(output.running === undefined ? {} : { running: output.running }),
          }),
          toModelOutput: ({ output }) => [
            { type: "text", text: output.output },
            { type: "text", text: modelOutput(output) },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              // 1H job-control path: observe/stop a job THIS session started. No new
              // permission assert — the original command was already approved, and
              // owner-binding means a session can only ever touch its own jobs.
              if (input.job !== undefined) {
                const action = input.action ?? "status"
                const job = yield* (action === "stop"
                  ? bashJobs.stop(input.job, context.sessionID)
                  : action === "wait"
                    ? bashJobs.wait(input.job, context.sessionID, input.timeout ?? 30_000)
                    : bashJobs.status(input.job, context.sessionID))
                return jobSnapshotOutput(job)
              }
              if (!input.command)
                return yield* Effect.fail(
                  new ToolFailure({ message: "Provide `command` to run something, or `job` to check a running job." }),
                )
              const commandText = input.command

              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external, "write"),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const warnings = externalCommandDirectories(commandText, target.canonical).map(
                (directory) =>
                  `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
              )
              yield* permission.assert({
                action: name,
                resources: [commandText],
                save: [commandText],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              const entries = yield* config.entries()
              const shell =
                Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])))
                  .shell ?? defaultShell()
              const command = ChildProcess.make(commandText, [], {
                cwd: target.canonical,
                shell,
                stdin: "ignore",
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
              })
              // 1H: run as a JOB and wait up to the soft deadline. A command that
              // outlives it is NOT killed — the model gets the job id + partial
              // output and decides: keep working, wait, or stop.
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              const { id } = yield* bashJobs.start({
                owner: context.sessionID,
                command,
                commandText,
                maxOutputBytes: MAX_CAPTURE_BYTES,
              })
              const job = yield* bashJobs.wait(id, context.sessionID, timeout).pipe(
                // start→wait on our own fresh id cannot miss; normalize the typed error away.
                Effect.catchTag("BashJobs.NotFoundError", () => Effect.die("bash job vanished between start and wait")),
              )
              if (job.running) {
                return {
                  output: job.output,
                  truncated: job.truncated,
                  timeout: true,
                  job: job.id,
                  running: true,
                  ...(warnings.length ? { warnings } : {}),
                }
              }

              const output = job.output || "(no output)"
              const notice = job.truncated
                ? "[output capture truncated at the in-memory safety limit. This is a PARTIAL view — " +
                  "do not conclude anything from output you cannot see here. Re-run narrower " +
                  "(grep/head/tail, or filter to the relevant lines) to read the omitted span.]"
                : undefined
              return {
                ...(job.exit !== undefined ? { exit: job.exit } : {}),
                output: notice ? `${output}\n\n${notice}` : output,
                truncated: job.truncated,
                ...(warnings.length ? { warnings } : {}),
              }
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                if (error instanceof BashJobs.JobNotFoundError)
                  return new ToolFailure({
                    message: `No job "${error.id}" belongs to this session — it may have expired (finished jobs are kept ~10 minutes) or the id is wrong.`,
                  })
                if (error instanceof BashJobs.JobLimitError)
                  return new ToolFailure({
                    message: `This session already has ${error.limit} running jobs. Wait for one ({"job": "<id>", "action": "wait"}) or stop one ({"job": "<id>", "action": "stop"}) before starting another command.`,
                  })
                return new ToolFailure({
                  message: `Unable to execute command: ${input.command ?? input.job ?? "(no command)"}`,
                })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    AppProcess.node,
    Config.node,
    PermissionV2.node,
    BashJobs.node,
  ],
})
