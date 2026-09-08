import { describe, expect, test } from "bun:test"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import { EventV2 } from "@novaclaw/core/event"
import { SessionMessage } from "@novaclaw/core/session/message"

const identity = {
  version: 1 as const,
  sessionID: SessionSchema.ID.make("ses_worker_protocol"),
  attemptID: "exe_worker_protocol",
  generation: 2,
}

describe("SessionWorkerProtocol", () => {
  test("round-trips lifecycle messages through newline framing", () => {
    const start = {
      ...identity,
      type: "start" as const,
      location: { directory: AbsolutePath.make("C:/project") },
      force: true,
    }
    const line = SessionWorkerProtocol.encodeLine(start)
    expect(line.endsWith("\n")).toBe(true)
    expect(SessionWorkerProtocol.decodeHostLine(line.trimEnd())).toEqual({ ok: true, message: start })

    const heartbeat = {
      ...identity,
      type: "heartbeat" as const,
      phase: "provider" as const,
      at: 1234,
      rssBytes: 128 * 1024 * 1024,
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(heartbeat).trimEnd())).toEqual({
      ok: true,
      message: heartbeat,
    })
  })

  test("round-trips event publication requests and host acknowledgements", () => {
    const publish = {
      ...identity,
      type: "publish-event" as const,
      requestID: "rpc_1",
      eventType: "session.next.synthetic",
      data: { sessionID: identity.sessionID, text: "progress" },
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(publish).trimEnd())).toEqual({
      ok: true,
      message: publish,
    })
    const acknowledged = {
      ...identity,
      type: "event-published" as const,
      requestID: publish.requestID,
      eventID: EventV2.ID.create(),
      durable: { aggregateID: identity.sessionID, seq: 7, version: 1 },
    }
    expect(SessionWorkerProtocol.decodeHostLine(SessionWorkerProtocol.encodeLine(acknowledged).trimEnd())).toEqual({
      ok: true,
      message: acknowledged,
    })
  })

  test("round-trips host-owned device arbitration", () => {
    const admit = {
      ...identity,
      type: "device-admit" as const,
      requestID: "rpc_device",
      deviceKey: "provider/model",
      sessionClass: "interactive" as const,
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(admit).trimEnd())).toEqual({
      ok: true,
      message: admit,
    })
    const admitted = { ...identity, type: "device-admitted" as const, requestID: admit.requestID }
    expect(SessionWorkerProtocol.decodeHostLine(SessionWorkerProtocol.encodeLine(admitted).trimEnd())).toEqual({
      ok: true,
      message: admitted,
    })

    const cron = { ...admit, requestID: "rpc_cron", sessionClass: "cron" as const }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(cron).trimEnd())).toEqual({
      ok: true,
      message: cron,
    })

    const maintenance = {
      ...identity,
      type: "device-maintenance-admit" as const,
      requestID: "rpc_maintenance",
      deviceKey: "provider/model",
      task: "session-title",
      concurrency: 4,
      locality: "lan" as const,
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(maintenance).trimEnd())).toEqual({
      ok: true,
      message: maintenance,
    })
    const maintenanceAdmitted = {
      ...identity,
      type: "device-maintenance-admitted" as const,
      requestID: maintenance.requestID,
      maintenanceID: "maintenance:1:session-title:ses_worker_protocol",
    }
    expect(
      SessionWorkerProtocol.decodeHostLine(SessionWorkerProtocol.encodeLine(maintenanceAdmitted).trimEnd()),
    ).toEqual({ ok: true, message: maintenanceAdmitted })

    const maintenanceRelease = {
      ...identity,
      type: "device-maintenance-release" as const,
      requestID: "rpc_maintenance_release",
      deviceKey: maintenance.deviceKey,
      maintenanceID: maintenanceAdmitted.maintenanceID,
    }
    expect(
      SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(maintenanceRelease).trimEnd()),
    ).toEqual({ ok: true, message: maintenanceRelease })

    const awaitPreemption = {
      ...maintenanceRelease,
      type: "device-maintenance-await-preemption" as const,
      requestID: "rpc_maintenance_preemption",
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(awaitPreemption).trimEnd())).toEqual(
      { ok: true, message: awaitPreemption },
    )
    const preempted = {
      ...identity,
      type: "device-maintenance-preempted" as const,
      requestID: awaitPreemption.requestID,
    }
    expect(SessionWorkerProtocol.decodeHostLine(SessionWorkerProtocol.encodeLine(preempted).trimEnd())).toEqual({
      ok: true,
      message: preempted,
    })
  })

  test("round-trips permission assertions and rejects the retired question sideband", () => {
    const permission = {
      ...identity,
      type: "permission-assert" as const,
      requestID: "rpc_permission",
      input: { sessionID: identity.sessionID, action: "read", resources: ["README.md"] },
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(permission).trimEnd())).toEqual({
      ok: true,
      message: permission,
    })
    const allowed = {
      ...identity,
      type: "permission-result" as const,
      requestID: permission.requestID,
      outcome: "allowed" as const,
    }
    expect(SessionWorkerProtocol.decodeHostLine(SessionWorkerProtocol.encodeLine(allowed).trimEnd())).toEqual({
      ok: true,
      message: allowed,
    })

    const question = {
      ...identity,
      type: "question-ask" as const,
      requestID: "rpc_question",
      input: {
        sessionID: identity.sessionID,
        questions: [{ header: "Proceed", options: [{ label: "Yes", description: "Continue" }] }],
      },
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(JSON.stringify(question))).toMatchObject({ ok: false })
    const answered = {
      ...identity,
      type: "question-result" as const,
      requestID: question.requestID,
      outcome: "answered" as const,
      answers: [["Yes"]],
    }
    expect(SessionWorkerProtocol.decodeHostLine(JSON.stringify(answered))).toMatchObject({ ok: false })
  })

  test("round-trips a spawned child's control binding", () => {
    const spawn = {
      ...identity,
      type: "spawn-child" as const,
      requestID: "rpc_spawn",
      input: { text: "Inspect the second display", controlBinding: ":100" },
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(spawn).trimEnd())).toEqual({
      ok: true,
      message: spawn,
    })
  })

  test("round-trips host-owned execution checkpoints", () => {
    const advance = {
      ...identity,
      type: "execution-advance" as const,
      requestID: "rpc_execution",
      phase: "tool" as const,
      checkpoint: "clear" as const,
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(advance).trimEnd())).toEqual({
      ok: true,
      message: advance,
    })
    for (const receipt of [
      {
        ...identity,
        type: "execution-tool-dispatched" as const,
        requestID: "rpc_dispatch",
        callID: "call_1",
        name: "write",
        sideEffect: "idempotent-write" as const,
      },
      { ...identity, type: "execution-tool-settled" as const, requestID: "rpc_settle", callID: "call_1" },
    ])
      expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(receipt).trimEnd())).toEqual({
        ok: true,
        message: receipt,
      })
    const applied = {
      ...identity,
      type: "execution-result" as const,
      requestID: advance.requestID,
      outcome: "applied" as const,
    }
    expect(SessionWorkerProtocol.decodeHostLine(SessionWorkerProtocol.encodeLine(applied).trimEnd())).toEqual({
      ok: true,
      message: applied,
    })

    // A serving identity crosses the worker boundary as its own message: the host owns the
    // accumulation, so a worker cannot shorten a receipt's provenance by sending a list.
    const servedBy = {
      ...identity,
      type: "execution-served-by" as const,
      requestID: "rpc_served",
      fingerprint: "vllm-0.9.2-a44fe734",
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(servedBy).trimEnd())).toEqual({
      ok: true,
      message: servedBy,
    })

    const contextUpdated = {
      ...identity,
      type: "execution-context-updated" as const,
      requestID: "rpc_context",
      messageID: SessionMessage.ID.make("msg_worker_context"),
      timestamp: 1234,
      text: "context changed",
      snapshot: {},
    }
    expect(SessionWorkerProtocol.decodeWorkerLine(SessionWorkerProtocol.encodeLine(contextUpdated).trimEnd())).toEqual({
      ok: true,
      message: contextUpdated,
    })
  })

  test("rejects malformed, unknown, wrong-version, and oversized messages without echoing content", () => {
    expect(SessionWorkerProtocol.decodeWorkerLine("not-json")).toEqual({
      ok: false,
      error: "worker message is not valid JSON",
    })
    for (const value of [
      { ...identity, type: "invented" },
      { ...identity, version: 2, type: "settled" },
      { ...identity, type: "heartbeat", phase: "invented", at: 1 },
      { ...identity, type: "heartbeat", phase: "drain", at: 1, rssBytes: -1 },
    ])
      expect(SessionWorkerProtocol.decodeWorkerLine(JSON.stringify(value))).toEqual({
        ok: false,
        error: "worker message does not match protocol version 1",
      })
    const secret = "s".repeat(SessionWorkerProtocol.MAX_MESSAGE_BYTES + 1)
    const oversized = SessionWorkerProtocol.decodeWorkerLine(secret)
    expect(oversized).toEqual({ ok: false, error: "worker message exceeds the 64 MiB limit" })
    expect(JSON.stringify(oversized)).not.toContain(secret)
  })

  test("rejects messages from a replaced execution generation", () => {
    const current = { ...identity, ownerID: "host-current" }
    expect(SessionWorkerProtocol.owns(current, { ...identity, type: "settled" })).toBe(true)
    expect(SessionWorkerProtocol.owns(current, { ...identity, generation: 1, type: "settled" })).toBe(false)
    expect(
      SessionWorkerProtocol.owns(current, {
        ...identity,
        attemptID: "exe_stale",
        type: "failed",
        classification: "crash",
      }),
    ).toBe(false)
  })
})
