/**
 * QE-A — the model-facing project provisioner. Rung 0 scans the project's manifests
 * for quality commands (deterministic, free); rung 1 VERIFIES each candidate by
 * running it once with a hard timeout (a hung command is the named failure loop —
 * the timeout is the fire-once rule; "toolchain missing" drops the candidate);
 * rung 2 is the calling model re-invoking with explicit commands for the gaps;
 * rung 3 (installing missing toolchains) deliberately stays a bash action under its
 * own permission gate. Resolved commands are written into the PROJECT novaclaw.jsonc
 * (`quality.commands`, comment-preserving patch) — active for future location boots.
 */
export * as QualityProvisionTool from "./quality-provision"

import { ToolFailure } from "@novaclaw/llm"
import fs from "node:fs/promises"
import path from "node:path"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { AppProcess } from "../process"
import type { Commands } from "../session/runner/quality"
import { QualityProvision } from "../session/runner/quality-provision"
import { Shell } from "../shell"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "quality_provision"
const VERIFY_TIMEOUT_MS = 90_000

const CommandOverrides = Schema.Struct({
  syntax: Schema.String.pipe(Schema.optional),
  check: Schema.String.pipe(Schema.optional),
  typecheck: Schema.String.pipe(Schema.optional),
  test: Schema.String.pipe(Schema.optional),
  lint: Schema.String.pipe(Schema.optional),
})

export const Input = Schema.Struct({
  commands: CommandOverrides.pipe(Schema.optional).annotate({
    description:
      "Explicit command overrides (win over the scan). Use when the scan missed something or proposed the wrong runner.",
  }),
  verify: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Run each candidate once to verify the toolchain exists (default true). Failing checks still count as verified — only 'command not found' drops a candidate.",
  }),
  write: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Write the resolved commands into the project novaclaw.jsonc (default true).",
  }),
})

export const Output = Schema.Struct({
  commands: CommandOverrides,
  dropped: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
  written: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => {
  const resolved = Object.entries(output.commands)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
  return [
    resolved.length ? `Provisioned quality commands:\n${resolved.join("\n")}` : "No quality commands could be resolved.",
    output.dropped.length ? `Dropped (toolchain missing or hung): ${output.dropped.join("; ")}` : "",
    output.written
      ? "Written to the project novaclaw.jsonc (quality.commands) — active for FUTURE sessions; this session's gates keep the boot snapshot."
      : "Not written (write: false or nothing resolved).",
    "Missing toolchains are installed via bash under its own approval — never automatically.",
  ]
    .filter(Boolean)
    .join("\n")
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    const appProcess = yield* AppProcess.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Provision this project's QUALITY commands (QE): scan the manifests (package.json/Cargo.toml/go.mod/pyproject/Makefile) for check/typecheck/test/lint commands, verify each candidate actually runs (a red check still verifies — only a missing toolchain drops it), and write the result into the project novaclaw.jsonc quality.commands. Pass explicit `commands` to override or fill gaps. Newly written commands activate for future sessions.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const directory = location.directory
                const entries = yield* Effect.tryPromise(() => fs.readdir(directory)).pipe(
                  Effect.catch(() => Effect.succeed([] as string[])),
                )
                const contents = new Map<string, string | undefined>()
                for (const manifest of ["package.json", "pyproject.toml", "requirements.txt", "Makefile"])
                  if (entries.includes(manifest))
                    contents.set(
                      manifest,
                      yield* Effect.tryPromise(() => fs.readFile(path.join(directory, manifest), "utf8")).pipe(
                        Effect.catch(() => Effect.succeed(undefined)),
                      ),
                    )
                const proposal = QualityProvision.scan({
                  files: entries,
                  read: (file) => contents.get(file),
                })
                const merged: { -readonly [K in keyof Commands]: Commands[K] } = { ...proposal.commands }
                for (const [key, value] of Object.entries(input.commands ?? {}))
                  if (value) merged[key as keyof Commands] = value
                const candidates = Object.entries(merged).filter(([, value]) => Boolean(value)) as Array<
                  [keyof Commands, string]
                >
                if (candidates.length === 0)
                  return yield* Effect.fail(
                    new ToolFailure({
                      message:
                        "No quality-command candidates: the scan found no known manifests and no explicit commands were passed. Inspect the project and re-call with explicit commands.",
                    }),
                  )
                yield* permission.assert({
                  action: "provision",
                  resources: candidates.map(([key, command]) => `${key}: ${command}`),
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const dropped: string[] = []
                if (input.verify !== false) {
                  const shell = Shell.agentDefault()
                  for (const [key, command] of [...candidates]) {
                    const run = yield* appProcess
                      .run(
                        ChildProcess.make(command, [], {
                          cwd: directory,
                          shell,
                          stdin: "ignore",
                          detached: process.platform !== "win32",
                          forceKillAfter: Duration.seconds(3),
                        }),
                        { combineOutput: true, timeout: Duration.millis(VERIFY_TIMEOUT_MS), maxOutputBytes: 16_384 },
                      )
                      .pipe(
                        Effect.map((result) => ({
                          exit: result.exitCode,
                          output: result.output?.toString("utf8") ?? "",
                        })),
                        Effect.catchTag("AppProcessError", (error) =>
                          Effect.succeed({
                            exit: undefined,
                            output: String(error.stderr ?? error.message ?? ""),
                            timedOut: /Timed out/i.test(String((error.cause as { message?: string } | undefined)?.message ?? "")),
                          }),
                        ),
                      )
                    const verdict = QualityProvision.classifyRun(run)
                    if (verdict !== "ran") {
                      dropped.push(`${key} (${command}) — ${verdict}`)
                      delete merged[key]
                    }
                  }
                }
                const remaining = Object.entries(merged).filter(([, value]) => Boolean(value))
                let written = false
                if (input.write !== false && remaining.length > 0) {
                  const configPath = path.join(directory, "novaclaw.jsonc")
                  const existing = yield* Effect.tryPromise(() => fs.readFile(configPath, "utf8")).pipe(
                    Effect.catch(() => Effect.succeed("")),
                  )
                  const patched = QualityProvision.patchProjectConfig(existing, merged)
                  yield* Effect.tryPromise(() => fs.writeFile(configPath, patched, "utf8"))
                  written = true
                }
                return { commands: merged, dropped, evidence: proposal.evidence, written }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({
                    message: `quality_provision failed: ${error instanceof Error ? error.message : String(error)}`,
                  })
                }),
              ),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/quality-provision",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Location.node, AppProcess.node],
})
