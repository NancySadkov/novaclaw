// Three things a HEADLESS CLI must never do, all three of which it used to do on the same command:
//
//   1. **Block waiting for a human.** `mcp auth <name>`, `mcp add`, `mcp logout`, `providers login`
//      and `providers logout` opened a clack prompt when a value was missing — `providers login`'s
//      API-key prompt with no flag, env var or stdin able to answer it at all. AGENTS.md principle
//      14 forbids this structurally, and forbids the two fixes that suggest themselves by name:
//      *"Do not add a mode that decides whether to block; do not add a timeout and call it safe.
//      Answer immediately, or do not ask."* So each one refuses and names what it needs.
//   2. **Exit 0 when the work failed.** Every one of those commands' error arms was
//      `log.error(...); outro("Done"); return`, and `mcp auth`'s `catchCause` converted the failure
//      into a success — so `nova-cli mcp auth my-server && echo ok` printed "Authentication failed"
//      AND "ok". A wrong exit code is worse than a crash for a headless tool: a script cannot tell.
//   3. **Collapse every non-zero intent to 1.** `src/index.ts` ended its catch block with an
//      unconditional `process.exitCode = 1`, which ran AFTER `FormatError` had set the code a
//      `CliError` carried — so `fail(message, 2)` could never exit 2.
//
// ⚠️ Why every refusal assertion checks `outputDiscarded` and `durationMs`: with the defect present
// the child does not exit at all, so the harness kills it at the timeout and synthesizes exit -1.
// "not zero" alone would therefore pass on a HANG, which is the very thing under test. A refusal is
// a process that exited on its own, quickly, having said why.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"
import type { RunResult } from "../lib/cli-process"

/** The child answered and left. Not: the harness ran out of patience and shot it. */
function expectRefused(result: RunResult, code: number, ...names: string[]) {
  expect(result.outputDiscarded ?? false, "the child was KILLED — it blocked instead of refusing").toBe(false)
  expect(result.exitCode).toBe(code)
  expect(result.durationMs).toBeLessThan(25_000)
  const output = result.stdout + result.stderr
  for (const name of names) expect(output).toContain(name)
}

// A catalog fixture is the only way to reach `providers login`'s API-key branch in a test: the CLI
// harness runs local-first, where the provider catalog is empty and any `--provider` is unknown.
// `NOVACLAW_MODELS_PATH` is models-dev's own offline-snapshot hook — no network, no server.
function catalogFixture(home: string): string {
  const file = path.join(home, "models-fixture.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      openai: { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"], models: {} },
    }),
  )
  return file
}

const CREDENTIAL = JSON.stringify({ openai: { type: "api", key: "stored-key" } })

describe("the CLI refuses instead of blocking on a human", () => {
  cliIt.concurrent(
    "providers login names the environment variable the API key must come from — it never prompts",
    ({ home, novaclaw }) =>
      Effect.gen(function* () {
        // THE headline leaf: `Prompt.password({message: "Enter your API key"})` had no
        // non-interactive escape of any kind, so a CI job or scheduled agent running this exact
        // argv got a process that never returned — and a killed process's output is discarded, so
        // the operator saw nothing at all.
        const refused = yield* novaclaw.spawn(["providers", "login", "--provider", "openai"], {
          env: { NOVACLAW_MODELS_PATH: catalogFixture(home) },
          timeoutMs: 25_000,
        })
        expectRefused(refused, 2, "NOVACLAW_API_KEY", "openai")

        // Control: the same argv, with the value it asked for, completes. A refusal that fires on a
        // fully-specified invocation is not a refusal, it is a broken command.
        const ok = yield* novaclaw.spawn(["providers", "login", "--provider", "openai"], {
          env: { NOVACLAW_MODELS_PATH: catalogFixture(home), NOVACLAW_API_KEY: "sk-supplied-by-the-caller" },
          timeoutMs: 25_000,
        })
        novaclaw.expectExit(ok, 0)
      }),
    90_000,
  )

  cliIt.concurrent(
    "providers login and logout refuse when the provider is not named, and name the ones that exist",
    ({ home, novaclaw }) =>
      Effect.gen(function* () {
        const models = catalogFixture(home)
        // Was `Prompt.autocomplete({message: "Select provider"})` in both commands.
        const login = yield* novaclaw.spawn(["providers", "login"], {
          env: { NOVACLAW_MODELS_PATH: models },
          timeoutMs: 25_000,
        })
        expectRefused(login, 2, "--provider")

        const logout = yield* novaclaw.spawn(["providers", "logout"], {
          env: { NOVACLAW_MODELS_PATH: models, NOVACLAW_AUTH_CONTENT: CREDENTIAL },
          timeoutMs: 25_000,
        })
        // The list the prompt would have rendered is printed instead — same information, no wait.
        expectRefused(logout, 2, "openai")

        // Control: named, it removes the credential and exits 0. Without this the refusal above
        // could be a command that simply never works.
        const removed = yield* novaclaw.spawn(["providers", "logout", "openai"], {
          env: { NOVACLAW_MODELS_PATH: models, NOVACLAW_AUTH_CONTENT: CREDENTIAL },
          timeoutMs: 25_000,
        })
        novaclaw.expectExit(removed, 0)
      }),
    90_000,
  )

  cliIt.concurrent(
    "mcp add refuses without a name instead of walking seven prompts",
    ({ home, novaclaw }) =>
      Effect.gen(function* () {
        const dbFile = path.join(home, "instance.db")
        const refused = yield* novaclaw.spawn(["mcp", "add"], { env: { NOVACLAW_DB: dbFile }, timeoutMs: 25_000 })
        expectRefused(refused, 2, "--url", "nova-cli mcp add <name>")

        // Control: the flag form still writes, and still says so.
        const added = yield* novaclaw.spawn(["mcp", "add", "oauthy", "--url", "https://example.com/mcp"], {
          env: { NOVACLAW_DB: dbFile },
          timeoutMs: 25_000,
        })
        novaclaw.expectExit(added, 0)
        expect(added.stdout + added.stderr).toContain("added to this instance's config")

        // And with a server configured, `mcp auth` with no positional refuses and lists it rather
        // than opening `Select MCP server to authenticate`.
        const auth = yield* novaclaw.spawn(["mcp", "auth"], { env: { NOVACLAW_DB: dbFile }, timeoutMs: 25_000 })
        expectRefused(auth, 2, "oauthy", "nova-cli mcp auth <name>")
      }),
    120_000,
  )
})

describe("a CLI command that fails exits non-zero", () => {
  cliIt.concurrent(
    "mcp auth, mcp logout and mcp debug report their failures in the exit code",
    ({ home, novaclaw }) =>
      Effect.gen(function* () {
        const env = { NOVACLAW_DB: path.join(home, "instance.db") }

        // Each of these was `log.error(...); outro("Done"); return` — printed, then exited 0.
        const auth = yield* novaclaw.spawn(["mcp", "auth", "nothing-configured"], { env, timeoutMs: 25_000 })
        expectRefused(auth, 1, "No OAuth-capable MCP servers configured")

        const logout = yield* novaclaw.spawn(["mcp", "logout", "never-stored"], { env, timeoutMs: 25_000 })
        expectRefused(logout, 1, "No MCP OAuth credentials stored")

        // `mcp debug`'s three guards lived INSIDE an `Effect.promise`, where `return` ends the async
        // body successfully — so the refusal never reached the exit code.
        const debug = yield* novaclaw.spawn(["mcp", "debug", "never-added"], { env, timeoutMs: 25_000 })
        expectRefused(debug, 1, "MCP server not found: never-added")

        // Control: a command that succeeds still exits 0, so the assertions above are not simply
        // "this binary always fails now".
        const list = yield* novaclaw.spawn(["mcp", "list"], { env, timeoutMs: 25_000 })
        novaclaw.expectExit(list, 0)
      }),
    120_000,
  )

  cliIt.concurrent(
    "a usage refusal exits 2 and a failed operation exits 1 — the codes are not both flattened to 1",
    ({ home, novaclaw }) =>
      Effect.gen(function* () {
        // This pair is the whole of the `CliError.exitCode` finding. `src/index.ts` used to end its
        // catch block with an unconditional `process.exitCode = 1`, run AFTER `FormatError` had
        // applied the code the CliError carried — so BOTH of these exited 1 and a script could not
        // tell "you invoked me wrong" from "the operation failed".
        const env = { NOVACLAW_DB: path.join(home, "instance.db") }
        const usage = yield* novaclaw.spawn(["mcp", "add", "named", "--url", "not a url"], { env, timeoutMs: 25_000 })
        expect(usage.exitCode).toBe(2)

        const failed = yield* novaclaw.spawn(["mcp", "logout", "never-stored"], { env, timeoutMs: 25_000 })
        expect(failed.exitCode).toBe(1)
      }),
    90_000,
  )
})

/**
 * The RATCHET. The four leaves above are instances; the class is "a command leaf that blocks on a
 * human", and the reason it was easy to write is that `cli/effect/prompt.ts` and `@clack/prompts`
 * offer blocking input as an ordinary call with no refusal built in — reaching for one is shorter
 * than refusing.
 *
 * Two leaves are not fixed here and are named, not hidden: `agent create` and `export` still prompt.
 * The assertion is that the set does not GROW, so this stays green when they are fixed too.
 *
 * ⚠️ Comments are stripped before matching. Every fix above documents the call it removed, so a
 * regex over raw source would count the prose describing the defect as the defect.
 */
const BLOCKING_CALLS = [
  "prompts.select(",
  "prompts.confirm(",
  "prompts.text(",
  "prompts.password(",
  "prompts.multiselect(",
  "prompts.groupMultiselect(",
  "prompts.autocomplete(",
  "Prompt.select(",
  "Prompt.text(",
  "Prompt.password(",
  "Prompt.autocomplete(",
  "UI.input(",
]

/** Files that may still block, each because its own prune is not in this change. */
const STILL_INTERACTIVE = ["cmd/agent.ts", "cmd/export.ts"]

/** The leaves this change made non-blocking. A prompt returning to any of them is a regression. */
const MUST_NOT_BLOCK = ["cmd/mcp.ts", "cmd/providers.ts", "cmd/stats.ts", "cmd/run.ts"]

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.isFile() && full.endsWith(".ts") ? [full] : []
  })
}

/** Block comments out, then any line that is a `//` comment or a docblock body. */
function withoutComments(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*")
    })
}

test("no CLI command leaf gains a new blocking prompt", () => {
  const cliRoot = path.resolve(import.meta.dir, "../../src/cli")
  const offenders: string[] = []
  for (const file of sourceFiles(cliRoot)) {
    // The module that DEFINES the primitives is not a leaf that calls one.
    if (file.endsWith(path.join("effect", "prompt.ts"))) continue
    const relative = path.relative(cliRoot, file).replaceAll(path.sep, "/")
    withoutComments(fs.readFileSync(file, "utf8")).forEach((line, index) => {
      for (const call of BLOCKING_CALLS) {
        if (line.includes(call)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`)
      }
    })
  }

  // Print the LINES, never a count: a bare total tells the next reader nothing about what moved.
  const files = [...new Set(offenders.map((entry) => entry.split(":")[0]))]
  expect(files.filter((file) => !STILL_INTERACTIVE.includes(file)), offenders.join("\n")).toEqual([])
  for (const owned of MUST_NOT_BLOCK) {
    expect(offenders.filter((entry) => entry.startsWith(owned)), `${owned} must never block on a human`).toEqual([])
  }
  // ⚠️ `STILL_INTERACTIVE` is an allowance, not a requirement: when one of those leaves is fixed,
  // delete its entry — an allowlist that outlives what it excused exempts a file nobody meant to.
})
