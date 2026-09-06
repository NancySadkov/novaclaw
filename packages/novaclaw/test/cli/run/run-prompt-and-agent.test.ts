// Two things `novaclaw run` must never get wrong, because both used to fail SILENTLY and exit 0:
//
//   1. **The model receives the prompt the user typed, byte for byte.** The CLI re-quoted every
//      argv element containing a space, so `novaclaw run "write a haiku"` delivered
//      `"write a haiku"` — quote characters and all — while a one-word prompt was delivered
//      verbatim. One command, two encodings.
//   2. **An `--agent` that cannot be honoured refuses the run.** A misspelled or subagent name
//      printed a warning and ran the task as whoever owned the session, without the named
//      colleague's grants, and exited 0.
//
// ⚠️ Both survived `run-process.test.ts` for the same reason: it asserts the model's canned REPLY
// and the CLI's exit code, never the prompt that reached the provider nor which agent ran. So these
// tests assert the WIRE (`llm.inputs`) and the event stream's `step_start.agent`, end to end from
// the argv a shell would hand us.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"
import { isMetadataRequest } from "../../lib/llm-server"

/**
 * Every user-authored text the provider actually received.
 *
 * Title generation is excluded: it re-sends the conversation inside a bigger prompt, so it would
 * make a "the model saw exactly this" assertion pass for the wrong reason.
 */
function userTexts(bodies: ReadonlyArray<Record<string, unknown>>): string[] {
  const out: string[] = []
  for (const body of bodies) {
    if (isMetadataRequest(body)) continue
    const messages = (body as { messages?: unknown }).messages
    if (!Array.isArray(messages)) continue
    for (const entry of messages as Array<Record<string, unknown>>) {
      if (entry?.["role"] !== "user") continue
      const content = entry["content"]
      if (typeof content === "string") out.push(content)
      else if (Array.isArray(content))
        for (const part of content as Array<Record<string, unknown>>)
          if (part?.["type"] === "text" && typeof part["text"] === "string") out.push(part["text"] as string)
    }
  }
  return out
}

describe("novaclaw run — the prompt on the wire", () => {
  cliIt.concurrent(
    "delivers the typed prompt to the model unchanged, quote characters and all",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        // ONE argv element holding spaces AND quotes — exactly what a shell hands the CLI for
        // `novaclaw run 'say "hi" to the world'`. This is the shape the old quoting rewrote.
        const prompt = 'say "hi" to the world'
        yield* llm.text("delivered")
        const result = yield* novaclaw.run(prompt)
        novaclaw.expectExit(result, 0)

        const texts = userTexts(yield* llm.inputs)
        // The load-bearing assertion: byte-identical, not merely "contains the words".
        expect(texts).toContain(prompt)
        // With the defect the model saw `"say \"hi\" to the world"`.
        expect(texts.some((text) => text.includes('\\"'))).toBe(false)
        expect(texts.some((text) => text.includes(`"${prompt}"`))).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "control: a prompt needing no quoting is unchanged too",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.text("delivered")
        const result = yield* novaclaw.run("ping")
        novaclaw.expectExit(result, 0)
        expect(userTexts(yield* llm.inputs)).toContain("ping")
      }),
    60_000,
  )

  // The OTHER consumer, and the reason the quoting existed at all: a slash command re-splits its
  // argument string (`expandCommandTemplate` tokenizes `"…"` as one argument), so a multi-word
  // argument must stay quoted THERE. Same argv, deliberately different encodings.
  cliIt.concurrent(
    "keeps the quoting on --command's argument string",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.text("command ran")
        const result = yield* novaclaw.run("two words", {
          command: "probe",
          env: {
            NOVACLAW_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              commands: { probe: { template: "ARGS: $ARGUMENTS", description: "argument echo probe" } },
            }),
          },
        })
        novaclaw.expectExit(result, 0)
        expect(userTexts(yield* llm.inputs)).toContain('ARGS: "two words"')
      }),
    60_000,
  )
})

describe("novaclaw run — an --agent that cannot be honoured", () => {
  cliIt.concurrent(
    "refuses an unknown agent instead of running as the default",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.text("should never be reached")
        const result = yield* novaclaw.run("audit the thing", { agent: "definitely-not-an-agent" })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("definitely-not-an-agent")
        // Nothing was sent to the provider: the refusal happens BEFORE the turn, so no output
        // exists that could be mistaken for the named colleague's work.
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.concurrent(
    "refuses a subagent named as the primary agent",
    ({ novaclaw }) =>
      Effect.gen(function* () {
        const result = yield* novaclaw.run("audit the thing", { agent: "general" })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("general")
        expect(result.stderr).toContain("subagent")
      }),
    60_000,
  )

  // The attach path resolves the name against a REMOTE roster and had the same silent fallback —
  // plus a third one the local path does not have, when the roster cannot be fetched at all.
  cliIt.concurrent(
    "refuses an unknown agent on the --attach path too",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        const server = yield* novaclaw.serve()
        yield* llm.text("should never be reached")
        const result = yield* novaclaw.run("audit the thing", {
          agent: "definitely-not-an-agent",
          extraArgs: ["--attach", server.url],
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("definitely-not-an-agent")
      }),
    60_000,
  )

  // The control that stops the refusal above from being a threshold that fires on normal input: a
  // name that DOES resolve still runs, and runs as that agent — read off the event stream, not
  // inferred from exit 0.
  cliIt.concurrent(
    "control: a resolvable --agent runs as that agent, and omitting it runs as the default",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.text("named agent ran")
        const named = yield* novaclaw.run("do the work", { agent: "build", format: "json" })
        novaclaw.expectExit(named, 0)
        const namedStart = novaclaw.parseJsonEvents(named.stdout).find((event) => event["type"] === "step_start")
        expect((namedStart?.["step"] as { agent?: string } | undefined)?.agent).toBe("build")

        yield* llm.text("default agent ran")
        const fallback = yield* novaclaw.run("do the work", { format: "json" })
        novaclaw.expectExit(fallback, 0)
        const defaultStart = novaclaw.parseJsonEvents(fallback.stdout).find((event) => event["type"] === "step_start")
        expect((defaultStart?.["step"] as { agent?: string } | undefined)?.agent).not.toBe("build")
      }),
    90_000,
  )
})
