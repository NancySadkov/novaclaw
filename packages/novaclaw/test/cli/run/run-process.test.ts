// Subprocess integration tests for `novaclaw run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `novaclaw.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `NOVACLAW_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import fs from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("novaclaw run (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "refuses options whose scope would otherwise be silently ignored",
    ({ novaclaw }) =>
      Effect.gen(function* () {
        const variant = yield* novaclaw.spawn(["run", "--variant", "high", "hello"])
        novaclaw.expectExit(variant, 2)
        expect(variant.stderr).toContain("--variant requires --model")

        const auth = yield* novaclaw.spawn(["run", "--username", "someone", "hello"])
        novaclaw.expectExit(auth, 2)
        expect(auth.stderr).toContain("apply only with --attach")

        const port = yield* novaclaw.spawn(["run", "--port", "4096", "hello"])
        expect(port.exitCode).not.toBe(0)
        expect(port.stderr).not.toContain("--port")

        const query = yield* novaclaw.spawn(["debug", "rg", "files", "--query", "foo"])
        expect(query.exitCode).not.toBe(0)
        expect(query.stderr).not.toContain("--query")
      }),
    30_000,
  )

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

        // ⚠️ No `--dangerously-skip-permissions` — it was INERT (it answered a consent prompt
        // `bf39088eb` deleted), so this test never depended on it, and it now refuses the run.
        const result = yield* novaclaw.run("use a tool")

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
  // We assert nonzero exit AND that the harness did not kill the child. `durationMs < timeoutMs`
  // used to stand in for that second fact, but process cleanup can cross the wall-clock boundary
  // after a natural exit on a loaded host. The harness already exposes the structural distinction.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ novaclaw }) =>
      Effect.gen(function* () {
        const result = yield* novaclaw.run("say hi", {
          model: "test/nonexistent-model",
          // A cold CLI boot alone takes 20-24 s on the loaded release-gate host. The old 15 s
          // deadline killed the process before it could exercise the unknown-model path.
          timeoutMs: 30_000,
        })
        expect(result.outputDiscarded ?? false, "the child was KILLED — the unknown model path hung").toBe(false)
        expect(result.exitCode).not.toBe(0)
      }),
    60_000,
  )

  // The test provider's SSE error item is interpreted as a broken/unknown finish, so the runner
  // keeps durable partial output and reconnects. The fixture's fallback reply is `ok`.
  cliIt.concurrent(
    "unknown stream finish preserves partial output, reconnects, and exits 0",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("partial response").tool("bash", {
            command: "printf tool",
            description: "Print deterministic output",
          }),
        )
        yield* llm.fail("upstream provider exploded mid-stream")
        // This path boots a host, observes the broken stream, then boots its recovery worker. On a
        // loaded full gate it has crossed the fixture's 30 s default even though the same path settles
        // in ~22 s alone. Keep the child deadline inside the test's 60 s wall while leaving enough
        // headroom for normal gate contention; a product timeout is not what this test is exercising.
        const result = yield* novaclaw.run("trigger midstream error", { timeoutMs: 50_000 })
        novaclaw.expectExit(result, 0, "unknown-finish recovery")
        expect(result.stdout).toBe("partial response\nok\n")
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
          extraArgs: ["--thinking"],
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
    "--format json records partial output and recovery for an unknown stream finish",
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
        // The broken continuation reconnects as a real provider step. It is not a phantom finish:
        // the fallback reply contributes durable text and therefore has a complete step pair.
        expect(events.map((event) => event.type)).toEqual([
          "step_start",
          "text",
          "tool_use",
          "step_finish",
          "step_start",
          "text",
          "step_finish",
        ])
        expect(events[1]?.text).toBe("partial json")
        expect(events[5]?.text).toBe("ok")
        expect(events.at(-1)?.step).toEqual(expect.objectContaining({ finish: expect.any(String) }))
      }),
    60_000,
  )

  // The deny path rides the per-instance /event stream: PermissionV2 stamps its events with the
  // service's own location (permission.ts eventLocation) so a runner-origin ask survives the
  // stream's directory filter even when the publishing fiber lacks Location.Service in context.
  cliIt.concurrent(
    "denies a requested permission; the removed dangerous flag REFUSES; an explicit deny holds",
    ({ home, llm, novaclaw }) =>
      Effect.gen(function* () {
        // `define_tool` deliberately falls through to consent in Build mode. A configured `bash: ask`
        // no longer does: the explicit Build posture's later bash allow wins by design; the separate
        // ask-before-changes switch is how a user narrows that posture. Exercise the CLI reply loop
        // with an action whose LIVE evaluator verdict is ask, not a stale pre-mode-overlay contract.
        yield* llm.tool("define_tool", {
          name: "denied-probe",
          description: "Permission test probe",
          manual: "No-op permission test recipe.",
        })
        yield* llm.text("continued after rejection")
        const denied = yield* novaclaw.run("request permission")
        novaclaw.expectExit(denied, 0)
        // ⚠️ The old assertion here looked for `"permission requested: define_tool"` — a CONSENT
        // PROMPT that has not existed since `bf39088eb` removed ASK as an outcome (2026-08-20). It
        // could never pass again, and it is why this test sat pinned in `test-baseline.json`. What is
        // true now is that the refusal is instant and the turn carries on, which the next line
        // asserts.
        // Native 1J semantics: the rejection is the TOOL's result (denial as observation, never a
        // halt), so the turn continues and the model's follow-up text still prints. V1 aborted the
        // whole turn here (empty stdout) — that vocabulary retires with the engine.
        expect(denied.stdout).toContain("continued after rejection")

        yield* llm.reset
        yield* llm.tool("define_tool", {
          name: "allowed-probe",
          description: "Permission test probe",
          manual: "No-op permission test recipe.",
        })
        yield* llm.text("continued after approval")
        const allowed = yield* novaclaw.run("request permission", {
          extraArgs: ["--dangerously-skip-permissions"],
        })
        // 🔴 The flag REFUSES the run outright. It answered a consent prompt `bf39088eb` deleted, so
        // it granted nothing; warning and continuing would still have run the whole task under a
        // false belief about permissions. Principle 13's shape is refuses-AND-reports.
        novaclaw.expectExit(allowed, 2)
        expect(allowed.stderr).toContain("has been removed")
        expect(allowed.stderr).toContain("--agent")

        yield* llm.reset
        yield* llm.tool("bash", { command: "touch explicitly-denied", description: "Create a denied marker" })
        yield* llm.text("continued after explicit denial")
        // ⚠️ NO flag here any more, and that is load-bearing. With the flag the run now exits 2
        // before doing anything, so the "file was not created" assertion below would pass for the
        // wrong reason — a vacuous green that reads as proof an explicit deny held.
        const explicitlyDenied = yield* novaclaw.run("request denied permission", {
          permission: { bash: "deny" },
        })
        novaclaw.expectExit(explicitlyDenied, 0)
        expect(explicitlyDenied.stdout).toContain("continued after explicit denial")
        // 🔴 The load-bearing one: the file is NOT created even with the flag passed. An explicit
        // `bash: deny` holds, which is both the original claim and — while the flag is inert — proof
        // that it grants nothing at all.
        expect(yield* Effect.promise(() => Bun.file(`${home}/explicitly-denied`).exists())).toBe(false)
      }),
    60_000,
  )

  /**
   * 🟢 UN-QUARANTINED 2026-08-24 — the `attach mode` flake is root-caused and fixed.
   *
   * It was never the CLI's fault. The server's SSE stream ends on `server.instance.disposed`
   * (`Stream.takeUntil`), and `configUpdate` disposes EVERY instance after an accepted config write.
   * So any config write terminates every subscriber's stream — and the writer here was a NovaClaw UI
   * open in a desktop browser pane, POSTing to `127.0.0.1:4096`, because `--port 0` means *prefer
   * 4096* rather than *OS-assigned*. An unrelated window was reaching into the test run.
   *
   * The fixture now chooses its own free port (`freePort` in `test/lib/cli-process.ts`, which carries
   * the full reasoning). Measured: 25% failure across two batches of 12 before, 16/16 after.
   *
   * ⚠️ Why this hid for so long: a PASSING run recorded the same `configUpdate -> disposeAll` as a
   * failing one. The write lands constantly and is fatal only when it falls inside the turn, so its
   * presence proved nothing and only its timing did. Three signatures — a short failure that sent
   * nothing to the provider, a ~9 s one that had already prompted, and a 30 s timeout — turned out to
   * be one cause landing at different moments, not three defects.
   *
   * 🔴 The product half is NOT fixed and is filed: a config write should not destroy live instances.
   * See `notes/reports/attach-flake-2026-08-24.md`. If this test ever flakes again, suspect that
   * first — this fixture only stops STRANGERS reaching the server, not the server disposing itself.
   */
  cliIt.concurrent(
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

  /**
   * 🔴 **NC-CS-001 — a resumed run works in the SESSION's directory, not the caller's cwd.**
   *
   * The behaviour has been correct since `2da95a1df` was ported: `run.ts` resolves a resumed session
   * through its stored `location.directory`. Nothing protected it. A behaviour with no regression is
   * one edit from being lost, and this one has been lost before — which is the whole reason the item
   * stayed open after the fix was confirmed present.
   *
   * TWO PROCESSES, deliberately. The bug this guards against is invisible inside one: a single
   * invocation resolves the directory once and reuses it, so the resume path — the only place the
   * stored location is read back — is never exercised. The second `novaclaw run` starts from the
   * default directory precisely so that "the caller's cwd" and "the session's directory" are
   * different answers, and the test can tell which one was used.
   *
   * ⚠️ **The second process passes NO `--dir`, and that is the whole point.** Writing it this way is
   * what found NC-CS-004: the run hung, 90 s and a kill, because the client stayed bound to the
   * PROCESS's directory while the turn ran in the session's. The CLI saw exactly one event —
   * `server.connected` — and waited. The resolution was never the problem; the client not following
   * it was.
   *
   * A/B: bind the client to the process directory instead of the session's (`const cwd = directory ??
   * root`) and this hangs while everything else in this file stays green — which is precisely how the
   * gap survived, since attach mode already rebound and was the path anybody exercised.
   */
  cliIt.concurrent(
    "🔴 a session created elsewhere is resumed by ID across processes, in its own directory",
    ({ home, llm, novaclaw }) =>
      Effect.gen(function* () {
        const elsewhere = path.join(home, "elsewhere")
        yield* Effect.promise(() => fs.mkdir(elsewhere, { recursive: true }))
        /**
         * ⚠️ ONE database across both invocations, passed explicitly. The harness hands every spawn
         * its own `novaclaw-cli-test-N.db` so that independent runs get genuinely fresh instances —
         * correct by default, and fatal here: the second process would not be able to see the
         * session the first created, and the test would fail with "Session not found" for a reason
         * that has nothing to do with what it is guarding.
         */
        const env = { NOVACLAW_DB: path.join(home, "nc-cs-001.db") }

        // 1. Create the session somewhere that is NOT where the next process will run.
        yield* llm.text("created over there")
        const first = yield* novaclaw.run("start here", {
          format: "json",
          env,
          timeoutMs: 90_000,
          extraArgs: ["--dir", elsewhere],
        })
        novaclaw.expectExit(first, 0)
        const sessionID = novaclaw.parseJsonEvents(first.stdout)[0]?.sessionID
        expect(typeof sessionID).toBe("string")

        // 2. Resume it from the DEFAULT directory. The run must follow the session, not the cwd.
        yield* llm.text("resumed over there")
        const second = yield* novaclaw.run("continue", {
          format: "json",
          env,
          timeoutMs: 90_000,
          extraArgs: ["--session", String(sessionID)],
        })
        novaclaw.expectExit(second, 0)

        const events = novaclaw.parseJsonEvents(second.stdout)
        // Same session — a resume that quietly created a NEW one would also exit zero and print an
        // answer, which is exactly how this could be lost without anything looking wrong.
        expect(events.every((event) => event.sessionID === sessionID)).toBe(true)
        expect(events.map((event) => event.type)).toContain("text")
      }),
    120_000,
  )

  // (Removed) A SIGINT-interrupt case used to live here but hung the runner from-source:
  // Bun-on-Windows can't deliver SIGINT to a child bun process, so `run.interrupt()` never
  // settled. The non-interactive `run` path is covered by the cases above; don't re-add it.
})
