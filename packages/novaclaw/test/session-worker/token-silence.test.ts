import { expect, test } from "bun:test"
import path from "node:path"
import { EventV2 } from "@novaclaw/core/event"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { spawn } from "../../src/session-worker/supervisor"

const fixture = path.resolve(import.meta.dir, "../fixtures/session-worker.ts")
const lease = {
  sessionID: SessionSchema.ID.make("ses_token_silence"),
  attemptID: "exe_token_silence",
  generation: 1,
  ownerID: "host-test",
}

const run = (mode: string) => spawn({
  command: [process.execPath, fixture, mode],
  lease,
  directory: process.cwd(),
  force: false,
  startupTimeoutMs: 8_000,
  heartbeatTimeoutMs: 2_000,
  tokenSilenceTimeoutMs: 250,
  onExecutionRequest: async (message) => ({
    version: 1,
    type: "execution-result",
    sessionID: message.sessionID,
    attemptID: message.attemptID,
    generation: message.generation,
    requestID: message.requestID,
    outcome: "applied",
  }),
  onPublishEvent: async (message) => ({
    version: 1,
    type: "event-published",
    sessionID: message.sessionID,
    attemptID: message.attemptID,
    generation: message.generation,
    requestID: message.requestID,
    eventID: EventV2.ID.create(),
  }),
})

test("heartbeats and non-token events cannot hide a silent provider", async () => {
  const outcome = await run("silent-provider").result
  expect(outcome.type).toBe("no-token-timeout")
}, 10_000)

test("a published token resets the silence clock", async () => {
  expect(await run("token-provider").result).toEqual({ type: "settled" })
}, 10_000)

test("a settled provider is not timed out while later work continues", async () => {
  expect(await run("settled-provider").result).toEqual({ type: "settled" })
}, 10_000)
