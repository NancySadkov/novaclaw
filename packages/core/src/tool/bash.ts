export * as BashTool from "./bash"

import path from "path"
import { ToolFailure } from "@novaclaw/llm"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AgentJail } from "../agent-jail"
import { Config } from "../config"
import { SettingsConfigStore } from "../settings-config-store"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { Offline } from "../offline"
import { AppProcess } from "../process"
import { Shell } from "../shell"
import { ShellBundle } from "../shell-bundle"
import { BashJobs } from "./bash-jobs"
import { MessengerStore } from "../messenger/store"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { rootSessionType } from "../session/config-resolve"
import type { SessionV2 } from "../session"
import { SessionStore } from "../session/store"
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

// B11: agents default to bash (bundled PortableGit or system git-bash on Windows;
// system bash on POSIX) — Shell.agentDefault() owns the resolution + fallbacks.
const defaultShell = () => Shell.agentDefault()

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
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const settingsStore = yield* SettingsConfigStore.Service
    const permission = yield* PermissionV2.Service
    const bashJobs = yield* BashJobs.Service
    const sessions = yield* SessionStore.Service
    const messengerStore = yield* MessengerStore.Service
    // OFF-C: the offline policy is a machine-level snapshot (flag-aware config dir);
    // consume the shared service so the guard sees the SAME policy as the HttpClient.
    const offline = yield* Offline.Service

    // messenger-plan §3.4 — is any session in this chain bound to a client/audience chat? Walk
    // parents (cycle-guarded) and check each for an active untrusted binding. Short chains; most
    // sessions have no binding so each check is a fast empty indexed lookup.
    const chainHasHostileBinding = (sessionID: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const seen = new Set<string>()
        let id: string | undefined = sessionID
        while (id !== undefined && !seen.has(id)) {
          seen.add(id)
          const bindings = yield* messengerStore.bindingsForSession(id).pipe(Effect.orElseSucceed(() => []))
          if (bindings.some((b) => b.status === "active" && (b.trust === "client" || b.trust === "audience"))) return true
          const session: SessionV2.Info | undefined = yield* sessions
            .get(id as SessionV2.ID)
            .pipe(Effect.orElseSucceed(() => undefined))
          id = session?.parentID
        }
        return false
      })

    yield* tools
      .register({
        [name]: Tool.make({
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. Prefer the dedicated \`read\`/\`edit\`/\`glob\`/\`grep\` tools over cat/sed/find/grep — they page and report limits safely. Output is capped at ${Math.round(MAX_CAPTURE_BYTES / 1024 / 1024)} MB: when the result says it was truncated, do not conclude from the missing span — re-run narrower (grep/head/tail). The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. The timeout is a SOFT deadline in milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}): a command that outlives it is NOT killed — it keeps running as a job and you get its id plus output-so-far; poll with {"job": "<id>"}, block with {"job": "<id>", "action": "wait", "timeout": 30000}, or terminate with {"job": "<id>", "action": "stop"}. Never re-run a command that yielded to a job — poll the job instead. Uses the configured shell when set; otherwise bash when available (the bundled shell or system bash), falling back to /bin/sh on POSIX and COMSPEC or cmd.exe on Windows.`,
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

              // Agent Jail P0b/P1 (notes/agent-jail-plan.md §2.3): in an UNATTENDED chain (root
              // type auto-prompting / goal-oriented) raw host execution additionally requires a
              // sandbox. With a backend (Linux namespaces, P1) the command runs CONFINED —
              // worktree-only FS, deny-all egress; with none it is DENIED, with routing to the
              // path-gated native tools. Attended chains (interactive roots + their sub-agents)
              // are untouched.
              // ⚠️ This check runs BEFORE the permission asserts, deliberately (deny-fast). It used
              // to sit after them, which meant an unattended session on a backend-less host (every
              // Windows host — no jail backend exists there) first raised a `bash` ask that nobody
              // was present to answer, and only WOULD have been denied afterwards. Measured live: a
              // queued recipe cook sat on three pending `bash` asks looking alive and doing
              // nothing. Asking for consent to run something we are certain to refuse is a hang,
              // not a gate. Attended behaviour is unchanged — an attended chain never takes the
              // deny arm, so its consent flow still happens exactly where it did.
              const rootType = yield* rootSessionType(context.sessionID, (id) =>
                sessions.get(id as SessionV2.ID),
              )
              // messenger-plan §3.4: a client/audience messenger binding ANYWHERE in this chain
              // makes the turn unattended hostile input — an untrusted stranger drives it, and the
              // recommended pattern (a bound session spawning a worker sub-agent) means the binding
              // can sit on an ancestor, so the whole chain is checked, not just this session.
              const hostileInput = yield* chainHasHostileBinding(context.sessionID)
              const jailDecision = AgentJail.decideBash({ rootType, backend: AgentJail.probe(), hostileInput })
              if (jailDecision === "deny")
                return yield* Effect.fail(new ToolFailure({ message: AgentJail.denyMessage(rootType, hostileInput) }))

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
              const mergedConfig = Object.assign(
                {},
                ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])),
              ) as { shell?: string }
              const shell = mergedConfig.shell ?? defaultShell()
              // `bash -c` is not a login shell: prepend the bash's own userland to PATH
              // so git + coreutils resolve even on a machine with neither installed
              // (no-op for non-MSYS shells — envForBash returns undefined for them).
              const bundleEnv =
                typeof shell === "string" && Shell.name(shell) === "bash" ? ShellBundle.envForBash(shell) : undefined
              // OFF-C (layer 9): in offline mode, point the child's HTTP clients (curl/pip/
              // npm/git) at a dead proxy sink with the allowlist in NO_PROXY, so the model's
              // own shell fails closed on WAN egress (no-op when offline mode is off).
              const egress = offline.egressEnv()
              // P2P: surface configured peer instances to the shell as env vars, so an agent can
              // drive them free-form (curl -u novaclaw:$NOVACLAW_INSTANCE_<NAME>_TOKEN <url>/...).
              // Read the LIVE settings store, NOT config.entries() — location config is snapshotted
              // at boot, so a peer added later (Settings → Instances) would be invisible to a
              // long-lived location otherwise (the flakiness this fixed).
              // ⚠️ Agent Jail P3: peer TOKENS are credentials, injected ONLY on the attended/raw
              // path. A confined (unattended) command self-revokes them — an injected command must
              // not wield cross-instance credentials it can't be supervised using (and can't reach a
              // peer through the netns anyway; this is the credential-zeroing half of that boundary).
              const peerEnv: Record<string, string> = {}
              if (jailDecision !== "confined") {
                const peers = ((yield* settingsStore.all()).instances ?? []) as ReadonlyArray<{
                  name: string
                  url: string
                  token?: string
                }>
                for (const peer of peers) {
                  const key = peer.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
                  if (!key || !peer.url) continue
                  peerEnv[`NOVACLAW_INSTANCE_${key}_URL`] = peer.url
                  if (peer.token) peerEnv[`NOVACLAW_INSTANCE_${key}_TOKEN`] = peer.token
                }
              }
              const baseSpawn = {
                cwd: target.canonical,
                stdin: "ignore",
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
              } as const
              // P1: a confined command execs bwrap directly (the sandbox runs `<shell> -c` itself;
              // no outer shell wrapping). The worktree = the session's location directory — the one
              // writable bind, i.e. the blast radius. P3: it starts from a CURATED, secret-free env
              // (extendEnv:false) — never the serve process's full environment (provider keys,
              // operator exports) — plus only the tool's own functional overlays.
              const command =
                jailDecision === "confined"
                  ? ChildProcess.make(
                      "bwrap",
                      AgentJail.wrapArgs({
                        worktree: location.directory,
                        cwd: target.canonical,
                        shell: String(shell),
                        command: commandText,
                      }),
                      {
                        ...baseSpawn,
                        env: { ...AgentJail.unattendedChildEnv(process.env), ...bundleEnv, ...egress },
                        extendEnv: false,
                      },
                    )
                  : ChildProcess.make(commandText, [], {
                      ...baseSpawn,
                      shell,
                      ...(bundleEnv || egress || Object.keys(peerEnv).length
                        ? { env: { ...bundleEnv, ...egress, ...peerEnv }, extendEnv: true }
                        : {}),
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
    Location.node,
    FSUtil.node,
    AppProcess.node,
    Config.node,
    SettingsConfigStore.node,
    PermissionV2.node,
    BashJobs.node,
    SessionStore.node,
    MessengerStore.node,
    Offline.node,
  ],
})
