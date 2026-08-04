import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AgentJail } from "@novaclaw/core/agent-jail"
import { Database } from "@novaclaw/core/database/database"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Config } from "@novaclaw/core/config"
import { SessionTable } from "@novaclaw/core/session/sql"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { LocationMutation } from "@novaclaw/core/location-mutation"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AppProcess } from "@novaclaw/core/process"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { BashTool } from "@novaclaw/core/tool/bash"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const runs: Array<{
  readonly command: string
  readonly cwd?: string
  readonly shell?: string | boolean
  readonly options?: AppProcess.RunOptions
  /** The composed child ENVIRONMENT stance (`HostExec.childEnv`). Captured because the credential
   *  boundary — who inherits the serve process's environment — is now a per-turn decision rather
   *  than a constant, and a test that cannot see it cannot pin it. */
  readonly extendEnv?: boolean
  readonly env?: Record<string, string | undefined>
}> = []
let denyAction: string | undefined
let result: AppProcess.RunResult = {
  command: "mock",
  exitCode: 0,
  output: Buffer.from("hello\n"),
  stdout: Buffer.from("hello\n"),
  stderr: Buffer.alloc(0),
  outputTruncated: false,
  stdoutTruncated: false,
  stderrTruncated: false,
}
let hang = false
let afterPermission = (_input: PermissionV2.AssertInput): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(Effect.suspend(() => afterPermission(input))),
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    // BashJobs consumes AppProcess.spawn (a streaming handle), not run: stream the mocked
    // output through `all` and settle `exitCode` from `result`. `hang` leaves exitCode pending
    // so BashJobs.wait times out (the long-running-job path).
    spawn: (command: ChildProcess.Command) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        const options = command.options as {
          readonly cwd?: string
          readonly shell?: string | boolean
          readonly extendEnv?: boolean
          readonly env?: Record<string, string | undefined>
        }
        runs.push({
          command: command.command,
          cwd: options.cwd,
          shell: options.shell,
          extendEnv: options.extendEnv,
          env: options.env,
        })
        return {
          // result.{output,stdout,stderr} are Node Buffers (already Uint8Arrays); stream
          // them directly — `new Uint8Array(Buffer)` trips the @types/node Buffer-generic
          // overload. The mock is force-cast below, so a Stream<Buffer> chunk is fine.
          all: Stream.fromIterable([result.output]),
          stdout: Stream.fromIterable([result.stdout]),
          stderr: Stream.fromIterable([result.stderr]),
          exitCode: hang ? Effect.never : Effect.succeed(result.exitCode),
        }
      }),
  } as unknown as AppProcess.Interface),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const reset = () => {
  assertions.length = 0
  runs.length = 0
  denyAction = undefined
  hang = false
  afterPermission = () => Effect.void
  result = {
    command: "mock",
    exitCode: 0,
    output: Buffer.from("hello\n"),
    stdout: Buffer.from("hello\n"),
    stderr: Buffer.alloc(0),
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  processLayer: Layer.Layer<AppProcess.Service> = appProcess,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        // Database is already a transitive dep (BashTool → SessionStore → Database); listing it
        // EXPOSES it so a test can seed the session row whose thread type drives the jail decision.
        LayerNode.group([
          Database.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          BashTool.node,
        ]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [AppProcess.node, processLayer],
          [Config.node, config],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof BashTool.Input.Type, id = "call-bash") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

const it = testEffect(Layer.empty)

describe("BashTool", () => {
  it.live("registers and returns structured successful output from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((tool) => tool.name)).toEqual(["bash"])
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.background")
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.description")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.output")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.command")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.cwd")
            expect(yield* toolDefinitions(registry, [{ action: "bash", resource: "*", effect: "deny" }])).toEqual([])
            expect(yield* settleTool(registry, call({ command: "pwd" }))).toEqual({
              result: {
                type: "content",
                value: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
              output: {
                structured: {
                  exit: 0,
                  truncated: false,
                },
                content: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
            })
            expect(runs).toMatchObject([{ command: "pwd", cwd: realpathSync(tmp.path) }])
            expect(assertions).toMatchObject([{ sessionID, action: "bash", resources: ["pwd"], save: ["pwd"] }])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => expect(runs).toMatchObject([{ cwd: realpathSync(path.join(tmp.path, "src")) }])),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "bash"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => {
              expect(runs).toEqual([])
              expect(assertions.map((input) => input.action)).toEqual(["bash"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (process.platform !== "win32") {
    it.live("executes a real shell command through AppProcess", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withTool(
            tmp.path,
            (registry) => settleTool(registry, call({ command: "printf core-bash" })),
            LayerNode.compile(AppProcess.node),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.result).toEqual({
                  type: "content",
                  value: [
                    { type: "text", text: "core-bash" },
                    { type: "text", text: "Command exited with code 0." },
                  ],
                })
                expect(settled.output?.structured).toMatchObject({
                  exit: 0,
                })
                expect(settled.output?.structured).not.toHaveProperty("output")
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("approves an explicit external workdir before bash execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withTool(active.path, (registry) =>
          executeTool(registry, call({ command: "pwd", workdir: outside.path })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory_write", "bash"])
              const root = realpathSync(outside.path).replaceAll("\\", "/")
              expect(assertions[0]).toMatchObject({
                resources: [root],
                save: [`${root}/*`],
                metadata: { targets: [root] },
              })
              expect(runs).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not execute after external-directory or bash denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          reset()
          denyAction = "external_directory_write"
          yield* withTool(active.path, (registry) =>
            executeTool(registry, call({ command: "pwd", workdir: outside.path })),
          )
          expect(assertions.map((item) => item.action)).toEqual(["external_directory_write"])
          expect(runs).toEqual([])

          reset()
          denyAction = "bash"
          yield* withTool(active.path, (registry) => executeTool(registry, call({ command: "pwd" })))
          expect(assertions.map((item) => item.action)).toEqual(["bash"])
          expect(runs).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("reports external command arguments as advisory warnings without enforcing approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "secret.txt")
        return withTool(active.path, (registry) => settleTool(registry, call({ command: `cat ${target}` }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["bash"])
              expect(runs).toHaveLength(1)
              expect(settled.output?.structured).toMatchObject({
                truncated: false,
              })
              expect(settled.output?.structured).not.toHaveProperty("warnings")
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Warnings:"),
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, exitCode: 7, output: Buffer.from("HEAD full output TAIL") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "false" }, "call-overflow"))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command exited with code 7"),
              })
              expect(settled.output?.structured).toMatchObject({
                exit: 7,
                truncated: false,
              })
              expect(settled.output?.content[0]).toEqual({ type: "text", text: "HEAD full output TAIL" })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces bounded process-capture truncation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        // BashJobs truncates by BYTES (maxOutputBytes), so stream just past the cap.
        result = { ...result, output: Buffer.alloc(BashTool.MAX_CAPTURE_BYTES + 16, 0x78) }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "verbose" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ truncated: true })
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("output capture truncated"),
              })
              expect(settled.output?.structured).not.toHaveProperty("resource")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // ⚠️ THIS TEST WAS INVERTED on 2026-07-30, and the inversion is the owner's directive rather than
  // a regression: *"unattended bash should be allowed by default, unless the user have enabled safe
  // mode in tuning. Otherwise the model wont be unable to do any useful work."* It used to assert
  // that an UNATTENDED session on a backend-less host (every Windows host) was refused up front.
  //
  // What survives unchanged is the ORDERING it was written to pin: the Agent Jail decision still
  // runs BEFORE the permission asserts, because the case it protects against — parking an ask
  // nobody is present to answer, measured live as a queued recipe cook sitting on three pending
  // `bash` asks looking alive and doing nothing — is now reached by the safe-mode and hostile-input
  // turns instead. That half is pinned at the gate (`test/unattended-bash-safe-mode.test.ts`,
  // `plan().via === "none"` means no process is described at all).
  //
  // This test's job is now the END-TO-END half of deliverable ①: through the real tool, with a real
  // session row and the default config, an unattended `bash` reaches consent and RUNS.
  it.live("an UNATTENDED session's bash is ALLOWED by default and runs (owner 2026-07-30)", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            // A scheduled/goal-oriented chain root: nobody is at the keyboard.
            const { db } = yield* Database.Service
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                slug: "bash-unattended",
                directory: tmp.path,
                title: "bash-unattended",
                version: "test",
                type: "goal-oriented",
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)

            const settled = yield* settleTool(registry, call({ command: "pwd" }))
            const backend = AgentJail.probe()
            // Same outcome either way now — that is the point. With a backend the command runs
            // sandboxed (bwrap); without one it runs raw. In BOTH cases consent is asserted and a
            // process is started, where a backend-less host used to short-circuit to an error.
            expect(assertions.map((input) => input.action)).toEqual(["bash"])
            expect(runs.length).toBe(1)
            expect((settled.result as { readonly type?: unknown }).type).not.toBe("error")
            // ⚠️ Agent Jail P3 on the newly-raw path: an unattended chain is not a chain a human
            // approved a command in, so the child must NOT inherit the serve process's environment
            // (provider keys, peer instance tokens) even though the jail now lets it run. Without
            // this assertion the reversal would have quietly widened the credential boundary too.
            const spawned = runs[0]!
            expect(spawned.extendEnv ?? false, "an unattended command inherited the operator's env").toBe(false)
            if (!(backend.fs && backend.net)) {
              // …and on a backend-less host it really is the raw shell path, not a silent no-op.
              expect(spawned.shell).toBeTruthy()
            }
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("an ATTENDED session still asks first, exactly where it always did", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                slug: "bash-attended",
                directory: tmp.path,
                title: "bash-attended",
                version: "test",
                type: "interactive",
              })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            yield* executeTool(registry, call({ command: "pwd" }))
            expect(assertions.map((input) => input.action)).toEqual(["bash"])
            expect(runs.length).toBe(1)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a useful timeout settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        hang = true // exitCode never settles → BashJobs.wait times out
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "sleep 60", timeout: 10 }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Still running after the soft deadline"),
              })
              expect(settled.output?.structured).toMatchObject({
                timeout: true,
                truncated: false,
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps locked deferred parity TODOs visible", async () => {
  const source = await fs.readFile(new URL("../src/tool/bash.ts", import.meta.url), "utf8")
  for (const todo of [
    "Port tree-sitter bash / PowerShell parser-based approval reduction.",
    // The old wording was "Port BashArity reusable command-prefix approvals." — it named
    // `novaclaw/src/permission/arity.ts`, an LLM-generated 137-entry command→arity table with no
    // importer, deleted 2026-07-29 with the rest of the §5 list. The CAPABILITY survives the table:
    // a pinned TODO must name what is still wanted, never a module that no longer exists.
    "Reusable command-prefix approvals — approve `git commit` once, not each full command string.",
    "Replace token-based command-argument external-directory advisories with parser-based detection.",
    "Restore PowerShell and cmd-specific invocation/path handling on Windows.",
    // Was "Add plugin shell.env environment augmentation once V2 plugin hooks exist." — the V1
    // `shell.env` hook is deleted (nothing outside `packages/plugin/src/example.ts` ever implemented
    // it) and re-adding a per-tool env hook would violate ruling 6. The remaining want is env
    // COMPOSITION, and it belongs to the one host-execution gate.
    // ⚠️ The only pin here that spans TWO source lines, so it carries the `\n// ` continuation
    // explicitly. A first-line-only pin ratchets half a sentence: the clause that actually forbids
    // the per-tool hook lives on line two, and could be edited or dropped with the gate still green.
    "Compose spawn environment in the ONE host-execution gate (`core/host-exec.ts`, ruling 6) so\n" +
      "// bash, ptys and every other spawn share one composed env — this must NOT come back as a per-tool hook.",
    "Add durable/live progress metadata streaming for long-running commands once V2 tool invocation progress context is wired.",
    "Persist background job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
    "Stream full shell output into managed storage while retaining only a bounded in-memory preview.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
