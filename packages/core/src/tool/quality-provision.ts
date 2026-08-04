/**
 * QE-A — the model-facing project provisioner. Rung 0 scans the project's manifests
 * for quality commands (deterministic, free); rung 1 VERIFIES each candidate by
 * running it once with a hard timeout (a hung command is the named failure loop —
 * the timeout is the fire-once rule; "toolchain missing" drops the candidate);
 * rung 2 is the calling model re-invoking with explicit commands for the gaps;
 * rung 3 (installing missing toolchains) deliberately stays a bash action under its
 * own permission gate.
 *
 * TWO permission actions, because this tool does two different things: `provision`
 * gates the durable settings write, and `bash` gates each command rung 1 actually
 * EXECUTES — the shell does not stop being the shell because the tool has a config
 * name, and a gate that only knows `provision` is a gate no `bash` rule can see.
 *
 * Resolved commands are written into the instance settings
 * store (`quality.commands` — the same record the Settings → Quality tab edits),
 * active for future location boots. ⚠️ The pre-config-sqlite version wrote a PROJECT
 * novaclaw.jsonc instead — a silent no-op since step 9 (nothing reads project jsonc
 * at runtime; the same dead-write class as the 4E promote bug). Per-PROJECT quality
 * overrides need a per-location config store first (filed in todo.md).
 */
export * as QualityProvisionTool from "./quality-provision"

import { ToolFailure } from "@novaclaw/llm"
import fs from "node:fs/promises"
import path from "node:path"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { MergePatch } from "../merge-patch"
import { PermissionV2 } from "../permission"
import { AppProcess } from "../process"
import type { Commands } from "../session/runner/quality"
import { QualityProvision } from "../session/runner/quality-provision"
import { SettingsConfigStore } from "../settings-config-store"
import { Shell } from "../shell"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "quality_provision"
const VERIFY_TIMEOUT_MS = 90_000

/**
 * The model-facing description — and under v0.2.0 ruling 4 that makes it a PRIVILEGED surface,
 * because it is text that reaches a future session's prompt by construction. So it may not
 * advertise an ecosystem the scan cannot detect, and it may not hide one it can: the manifest
 * names below are pinned EQUAL to `QualityProvision.MANIFEST_TRIGGERS` by
 * `test/quality-provision-drift.test.ts`, in both directions. Before this pin the prose named
 * five manifests while the table understood seven — a description and a behaviour free to drift
 * apart while compiling green, which is the defect class ruling 1 exists to close.
 *
 * ⚠️ Naming a manifest anywhere in this string is therefore a claim the table has to back. Add
 * the rule first, then the name.
 */
export const description =
  "Provision this project's QUALITY commands (QE): scan the project's own manifests — " +
  "package.json, Cargo.toml, go.mod, pyproject.toml, requirements.txt, setup.py, Makefile, " +
  "CMakeLists.txt, build.gradle, pom.xml, *.sln, *.csproj, Gemfile — for typecheck/test/lint " +
  "commands, verify each candidate actually runs (a red check still verifies — only a missing " +
  "toolchain drops it), and save the result to the instance quality settings (the record " +
  "Settings → Quality edits). Pass explicit `commands` to override or fill gaps; a per-file " +
  "`check` or `syntax` command may use `{file}` for the path of the file that was just written. " +
  "Newly saved commands activate for future sessions."

/**
 * The top-level entries whose TEXT the scan will need, DERIVED from the manifest table rather
 * than restated here. This used to be a hardcoded `["package.json", "pyproject.toml",
 * "requirements.txt", "Makefile"]` in the loop below: it happened to match the table, nothing
 * checked that it did, and adding a content-reading ecosystem to the scan would have compiled
 * green while that ecosystem silently never saw its own manifest. (It did NOT break Rust or Go —
 * `Cargo.toml` and `go.mod` are detected by name and need no read at all.)
 */
export const manifestsToRead = (entries: readonly string[]): readonly string[] =>
  QualityProvision.MANIFEST_READS.filter((manifest) => entries.includes(manifest))

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
      "Explicit command overrides (win over the scan). Use when the scan missed something or proposed the wrong runner. `check` and `syntax` run PER WRITTEN FILE, so give them a `{file}` placeholder (e.g. `ruff check {file}`); `typecheck`, `test` and `lint` are whole-project and take no file.",
  }),
  verify: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Run each candidate once to verify the toolchain exists (default true). Failing checks still count as verified — only 'command not found' drops a candidate.",
  }),
  write: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Save the resolved commands to this instance's quality settings (default true).",
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
    resolved.length
      ? `Provisioned quality commands:\n${resolved.join("\n")}`
      : "No quality commands could be resolved.",
    output.dropped.length ? `Dropped (toolchain missing or hung): ${output.dropped.join("; ")}` : "",
    output.written
      ? "Saved to the instance quality settings (Settings → Quality) — active for FUTURE sessions; this session's gates keep the boot snapshot."
      : "Not saved (write: false or nothing resolved).",
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
    const settings = yield* SettingsConfigStore.Service

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            description,
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
                for (const manifest of manifestsToRead(entries))
                  contents.set(
                    manifest,
                    yield* Effect.tryPromise(() => fs.readFile(path.join(directory, manifest), "utf8")).pipe(
                      Effect.catch(() => Effect.succeed(undefined)),
                    ),
                  )
                const proposal = QualityProvision.scan({
                  files: entries,
                  read: (file) => contents.get(file),
                  // The family of the shell these commands will actually run in — Git Bash on
                  // Windows whenever one is found, cmd.exe only as the documented fallback. It
                  // decides `./gradlew` vs `gradlew.bat`; guessing from process.platform would get
                  // the common Windows case backwards.
                  shell: Shell.agentShellIsPosix() ? "posix" : "cmd",
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
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                // The CONFIG half: this call is about to persist `quality.commands` into the
                // instance settings store, a durable host mutation under its own action name.
                // It does NOT cover the execution below — see the `bash` assert in the loop.
                yield* permission.assert({
                  action: "provision",
                  resources: candidates.map(([key, command]) => `${key}: ${command}`),
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const dropped: string[] = []
                if (input.verify !== false) {
                  const shell = Shell.agentDefault()
                  for (const [key, template] of [...candidates]) {
                    // Rung 1 asks ONE question — does this toolchain exist — so a `{file}`
                    // placeholder is dropped instead of executed literally. `ruff check {file}` run
                    // as written makes ruff say `No such file or directory`, which classifyRun reads
                    // as a missing toolchain: a good per-file check discarded and the reason
                    // misreported (ruling 2). `template` is what gets SAVED; `command` is what runs.
                    const command = QualityProvision.verifiableCommand(template)
                    // ⚠️ THE EXECUTION HALF, and it must be spelled `bash`. Verification runs this
                    // command string through the agent shell with the host user's authority, and the
                    // string can come straight from the MODEL (`input.commands` wins over the scan).
                    // Asserting only `provision` above made this a second door onto the shell that
                    // every `bash` rule missed by name: "Ask before every change" promises the user
                    // is asked "before it runs a shell command" (i18n `prompt.features.
                    // askBeforeChanges.description`) and its overlay lists `bash`, so provisioning
                    // executed without ever asking. Enumerating `provision` in each such rule list
                    // would patch this instance and leave the class; asserting the action that
                    // MATCHES WHAT WE ARE DOING makes every bash rule — mode denies, the switch,
                    // saved user answers, and any rule added later — apply here for free.
                    //
                    // Same shape as `tool/bash.ts` deliberately (`resources: [command]`,
                    // `save: [command]`): one vocabulary means an "always allow" answered for a
                    // command is the same grant whichever tool runs it.
                    yield* permission.assert({
                      action: "bash",
                      resources: [command],
                      save: [command],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
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
                            timedOut: /Timed out/i.test(
                              String((error.cause as { message?: string } | undefined)?.message ?? ""),
                            ),
                          }),
                        ),
                      )
                    const verdict = QualityProvision.classifyRun(run)
                    if (verdict !== "ran") {
                      dropped.push(`${key} (${template}) — ${verdict}`)
                      delete merged[key]
                    }
                  }
                }
                const remaining = Object.entries(merged).filter(([, value]) => Boolean(value))
                let written = false
                if (input.write !== false && remaining.length > 0) {
                  // The instance settings store — the SAME record Settings → Quality edits, and the
                  // only quality config the runtime reads (config-sqlite step 9: project jsonc is
                  // never read at runtime; writing it here was a silent no-op).
                  const current = (yield* settings.all()).quality
                  yield* settings.set("quality", MergePatch.mergePatch(current, { commands: merged }))
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
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/quality-provision",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Location.node, AppProcess.node, SettingsConfigStore.node],
})
