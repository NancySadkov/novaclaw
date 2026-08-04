// Subprocess integration tests for `novaclaw run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `novaclaw.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `NOVACLAW_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

describe("novaclaw run (non-interactive subprocess)", () => {
  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* novaclaw.run("say hi")
        novaclaw.expectExit(result, 0)
        expect(result.stdout).toBe("hello from the test llm\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints each completed text part in order around a tool continuation",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("  before tool  ").tool("bash", {
            command: "printf tool-output",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("  after tool  ")

        const result = yield* novaclaw.run("use a tool", {
          extraArgs: ["--dangerously-skip-permissions"],
        })

        novaclaw.expectExit(result, 0)
        expect(result.stdout).toBe("before tool\nafter tool\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "prints reasoning before text only with --thinking",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.reason("  considering  ", { text: "  answer  " })
        const thinking = yield* novaclaw.run("think", { extraArgs: ["--thinking"] })
        novaclaw.expectExit(thinking, 0)
        expect(thinking.stdout).toBe("Thinking: considering\nanswer\n")

        yield* llm.reason("hidden", { text: "visible" })
        const plain = yield* novaclaw.run("think again")
        novaclaw.expectExit(plain, 0)
        expect(plain.stdout).toBe("visible\n")
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ novaclaw }) =>
      Effect.gen(function* () {
        const result = yield* novaclaw.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 15_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  // The test provider's SSE error item is interpreted by the SDK as an unknown
  // finish, not a fatal provider/session error. Lock that distinction in so it
  // is not accidentally used as the failure compatibility oracle.
  cliIt.concurrent(
    "unknown stream finish preserves partial output and exits 0",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial response").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("upstream provider exploded mid-stream")
        const result = yield* novaclaw.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("partial response\n")
        expect(result.stderr).not.toContain("upstream provider exploded mid-stream")
      }),
    60_000,
  )

  // Regression (2026-07-15): a non-TTY stdin held OPEN but silent — the CI/process-runner
  // spawn shape — parked `Bun.stdin.text()` forever, hanging the whole run before any
  // output. With a message argument present, stdin is optional input: the run must give
  // the pipe a short grace window and proceed without it. Uses startRun with
  // stdin:"held-open-pipe" — the pipe is deliberately never written to or closed.
  cliIt.concurrent(
    "completes with a message argument while a silent stdin pipe stays open",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.text("survived the open pipe")
        const handle = yield* novaclaw.startRun("say hi", { stdin: "held-open-pipe" })
        const result = yield* handle.result
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("survived the open pipe\n")
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* novaclaw.run("say hi", { format: "json" })
        novaclaw.expectExit(result, 0)

        const events = novaclaw.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        expect(events.map((event) => event.type)).toEqual(["step_start", "text", "step_finish"])
        expect(events.map(({ timestamp: _, sessionID: __, ...event }) => event)).toEqual([
          {
            type: "step_start",
            step: expect.objectContaining({ agent: expect.any(String), model: expect.any(Object) }),
          },
          { type: "text", text: "structured output" },
          { type: "step_finish", step: expect.objectContaining({ finish: expect.any(String) }) },
        ])
        expect(result.stdout.endsWith("\n")).toBe(true)
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.length > 0),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json emits a pure error record for a rejected prompt request",
    ({ novaclaw }) =>
      Effect.gen(function* () {
        const result = yield* novaclaw.run("use an unknown model", {
          model: "test/nonexistent-model",
          format: "json",
        })

        expect(result.exitCode).not.toBe(0)
        const events = novaclaw.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual(["error"])
        expect(events[0]).toEqual({
          type: "error",
          timestamp: expect.any(Number),
          sessionID: expect.any(String),
          error: expect.any(Object),
        })
        expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1)
      }),
    30_000,
  )

  cliIt.concurrent(
    "--format json preserves reasoning, tool, and continuation ordering",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().reason("reasoning").text("before").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.text("after")

        const result = yield* novaclaw.run("exercise json records", {
          format: "json",
          extraArgs: ["--thinking", "--dangerously-skip-permissions"],
        })

        expect(result.exitCode).toBe(0)
        const events = novaclaw.parseJsonEvents(result.stdout)
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "reasoning",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events.find((event) => event.type === "reasoning")?.text).toBe("reasoning")
        expect(events.find((event) => event.type === "tool_use")).toEqual(
          expect.objectContaining({
            tool: "bash",
            callID: expect.any(String),
            input: expect.objectContaining({ command: "printf tool" }),
            output: expect.any(String),
          }),
        )
        expect(
          result.stdout
            .split("\n")
            .slice(0, -1)
            .every((line) => line.startsWith("{")),
        ).toBe(true)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--format json records partial output for an unknown stream finish",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial json").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("provider failed")
        const result = yield* novaclaw.run("fail after output", { format: "json" })

        const events = novaclaw.parseJsonEvents(result.stdout)
        expect(result.exitCode).toBe(0)
        // Native vocab: a continuation whose stream fails before producing content never
        // starts a step, so no phantom step_start/step_finish pair follows the tool turn
        // (V1 synthesized a second step with finish reason "unknown" here).
        expect(events.map((event) => event.type)).toEqual(["step_start", "text", "tool_use", "step_finish"])
        expect(events[1]?.text).toBe("partial json")
        expect(events.at(-1)?.step).toEqual(expect.objectContaining({ finish: expect.any(String) }))
      }),
    60_000,
  )

  // The deny path rides the per-instance /event stream: PermissionV2 stamps its events with the
  // service's own location (permission.ts eventLocation) so a runner-origin ask survives the
  // stream's directory filter even when the publishing fiber lacks Location.Service in context.
  cliIt.concurrent(
    "rejects requested permissions by default and allows them with the dangerous flag",
    ({ home, llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.tool("bash", { command: "rm -f denied-file", description: "Remove a test file" })
        yield* llm.text("continued after rejection")
        const denied = yield* novaclaw.run("request permission", { permission: { bash: "ask" } })
        novaclaw.expectExit(denied, 0)
        expect(denied.stderr).toContain("permission requested: bash")
        // Native 1J semantics: the rejection is the TOOL's result (denial as observation, never a
        // halt), so the turn continues and the model's follow-up text still prints. V1 aborted the
        // whole turn here (empty stdout) — that vocabulary retires with the engine.
        expect(denied.stdout).toContain("continued after rejection")

        yield* llm.reset
        yield* llm.tool("bash", { command: "rm -f allowed-file", description: "Remove a test file" })
        yield* llm.text("continued after approval")
        const allowed = yield* novaclaw.run("request permission", {
          permission: { bash: "ask" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        novaclaw.expectExit(allowed, 0)
        expect(allowed.stderr).not.toContain("permission requested: bash")
        expect(allowed.stdout).toContain("continued after approval")

        yield* llm.reset
        yield* llm.tool("bash", { command: "touch explicitly-denied", description: "Create a denied marker" })
        yield* llm.text("continued after explicit denial")
        const explicitlyDenied = yield* novaclaw.run("request denied permission", {
          permission: { bash: "deny" },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        novaclaw.expectExit(explicitlyDenied, 0)
        expect(explicitlyDenied.stdout).toContain("continued after explicit denial")
        expect(yield* Effect.promise(() => Bun.file(`${home}/explicitly-denied`).exists())).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "attach mode sends client-local file contents without a shared path",
    ({ home, llm, novaclaw }) =>
      Effect.gen(function* () {
        const source = `${home}/client-only.txt`
        const sentinel = "client-only attachment sentinel"
        yield* Effect.promise(() => Bun.write(source, sentinel))
        yield* llm.text("attachment received")
        const server = yield* novaclaw.serve()

        const result = yield* novaclaw.run("read the attachment", {
          extraArgs: ["--attach", server.url, `--file=${source}`, "--"],
        })

        novaclaw.expectExit(result, 0)
        const input = JSON.stringify(yield* llm.inputs)
        expect(input).toContain(sentinel)
        expect(input).not.toContain(`file://${source}`)
      }),
    60_000,
  )

  cliIt.concurrent(
    "attach mode rejects local directories before prompt admission",
    ({ home, novaclaw }) =>
      Effect.gen(function* () {
        const result = yield* novaclaw.run("read the directory", {
          extraArgs: ["--attach", "http://127.0.0.1:1", `--file=${home}`, "--"],
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Cannot attach local directory without a shared filesystem")
      }),
    30_000,
  )

  // (Removed) A SIGINT-interrupt case used to live here but hung the runner from-source:
  // Bun-on-Windows can't deliver SIGINT to a child bun process, so `run.interrupt()` never
  // settled. The non-interactive `run` path is covered by the cases above; don't re-add it.
})
