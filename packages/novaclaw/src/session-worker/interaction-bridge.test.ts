import { expect, test } from "bun:test"
import { Effect } from "effect"
import { PermissionV2 } from "@novaclaw/core/permission"
import { QuestionV2 } from "@novaclaw/core/question"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionWorkerInteractionBridge } from "./interaction-bridge"

const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_interaction"),
  attemptID: "exe_worker_interaction",
  generation: 5,
  ownerID: "host",
}
const base = {
  version: 1 as const,
  sessionID: lease.sessionID,
  attemptID: lease.attemptID,
  generation: lease.generation,
}
const unusedPermission = {
  ask: () => Effect.die("unused"),
  assert: () => Effect.void,
  reply: () => Effect.die("unused"),
  get: () => Effect.succeed(undefined),
  forSession: () => Effect.succeed([]),
  list: () => Effect.succeed([]),
} as PermissionV2.Interface
const unusedQuestion = {
  ask: () => Effect.succeed([["Yes"]]),
  reply: () => Effect.die("unused"),
  reject: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
} as QuestionV2.Interface

test("permission assertion and question answers stay in host services", async () => {
  const permission = {
    ...unusedPermission,
    assert: (value: PermissionV2.AssertInput) =>
      value.sessionID === lease.sessionID ? Effect.void : Effect.die("cross-session permission"),
  }
  const allowed = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission,
      question: unusedQuestion,
      lease,
      message: {
        ...base,
        type: "permission-assert",
        requestID: "rpc_permission",
        input: { sessionID: lease.sessionID, action: "read", resources: ["README.md"] },
      },
    }),
  )
  expect(allowed).toMatchObject({ type: "permission-result", outcome: "allowed" })

  const answered = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission,
      question: unusedQuestion,
      lease,
      message: {
        ...base,
        type: "question-ask",
        requestID: "rpc_question",
        input: {
          sessionID: lease.sessionID,
          questions: [
            { header: "Proceed", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] },
          ],
        },
      },
    }),
  )
  expect(answered).toMatchObject({ type: "question-result", outcome: "answered", answers: [["Yes"]] })
})

test("permission denial details survive while stale and cross-session requests fail closed", async () => {
  const deniedPermission = {
    ...unusedPermission,
    assert: () =>
      Effect.fail(
        new PermissionV2.DeniedError({
          rules: [{ action: "write", resource: "outside", effect: "deny" }],
          reason: "unattended-confined",
        }),
      ),
  } as PermissionV2.Interface
  const denied = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: deniedPermission,
      question: unusedQuestion,
      lease,
      message: {
        ...base,
        type: "permission-assert",
        requestID: "rpc_denied",
        input: { sessionID: lease.sessionID, action: "write", resources: ["outside"] },
      },
    }),
  )
  expect(denied).toMatchObject({
    type: "permission-result",
    outcome: "denied",
    reason: "unattended-confined",
  })

  const stale = await Effect.runPromise(
    SessionWorkerInteractionBridge.handle({
      permission: deniedPermission,
      question: unusedQuestion,
      lease,
      message: {
        ...base,
        generation: lease.generation - 1,
        type: "question-ask",
        requestID: "rpc_stale",
        input: { sessionID: lease.sessionID, questions: [] },
      },
    }),
  )
  expect(stale).toMatchObject({ type: "question-result", outcome: "rejected" })
})
