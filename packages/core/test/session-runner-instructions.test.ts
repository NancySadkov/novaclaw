import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionTable } from "@novaclaw/core/session/sql"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionV2 } from "@novaclaw/core/session"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * The AGENTS.md opt-in must take effect while a session is LIVE.
 *
 * 🔴 Owner report, 2026-09-17: `Instructions from: …AGENTS.md` still arrived after the opt-in was
 * turned off. The cause was the context epoch's deliberate design — the baseline is established once
 * and a source that vanishes becomes a tail "no longer applies" notice — which cannot remove bytes
 * from a frozen SYSTEM prompt. A runner-chosen source now declares its presence
 * (`SessionContextEpoch.SourcePresence`), and a mismatch rebuilds the baseline.
 *
 * ⚠️ This exercises the REAL `InstructionContext` (the harness leaves its node in place), so it is the
 * integration of the discovery walk, the per-agent switch, and the epoch — not a unit of the switch.
 */
describe("SessionRunnerLLM — the AGENTS.md opt-in takes effect on a live session", () => {
  test("turning the opt-in OFF rebuilds the baseline without the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-instructions-"))
    try {
      const marker = "INSTRUCTION-MARKER-for-opt-in"
      await fs.writeFile(path.join(dir, "AGENTS.md"), marker)

      const harness = makeRunnerHarness({
        directory: AbsolutePath.make(dir),
        turns: [completeTurn("t1", "One"), completeTurn("t2", "Two")],
      })

      await drive(
        harness,
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.mode = "primary"
              agent.instructions = true
            }),
          )
          yield* db
            .update(SessionTable)
            .set({ agent: "reviewer" })
            .where(eq(SessionTable.id, HARNESS_SESSION))
            .run()
            .pipe(Effect.orDie)

          const session = yield* SessionV2.Service
          yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
          yield* session.resume(HARNESS_SESSION)

          // The user turns the officer's "Read this folder's AGENTS.md" switch off.
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.instructions = false
            }),
          )

          yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
          yield* session.resume(HARNESS_SESSION)
        }),
        "claim — the opt-in takes effect on a live session",
      )

      const sent = (index: number) => JSON.stringify((harness.requests[index]?.system ?? []).map((part) => part.text))
      expect(sent(0), "opted in: the file reaches the system prompt").toContain(marker)
      expect(sent(1), "opted out: the rebuilt baseline no longer carries the file").not.toContain(marker)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
