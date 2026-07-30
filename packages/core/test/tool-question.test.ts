import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PermissionV2 } from "@novaclaw/core/permission"
import { QuestionV2 } from "@novaclaw/core/question"
import { SessionV2 } from "@novaclaw/core/session"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { QuestionTool } from "@novaclaw/core/tool/question"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_question_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let captured: QuestionV2.AskInput | undefined
let reject = false
/**
 * Set to make the permission gate fail. ⚠️ `assert`'s error channel is
 * `PermissionV2.Error | SessionV2.NotFoundError` — and `PermissionV2.Error` is the module's own
 * union (`DeniedError | RejectedError | CorrectedError`), NOT the global `Error`. `denialMessage`
 * answers all three of those, so `NotFoundError` is the only member it declines, which makes it the
 * one honest negative control available here — and the one case the tool's old hardcoded
 * "Permission denied: question" described falsely.
 */
let assertFailure: PermissionV2.Error | SessionV2.NotFoundError | undefined
const capturedInput = () => captured
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.gen(function* () {
        assertions.push(input)
        // No `return` — returning the failed effect widens the success channel to `undefined`,
        // which is not assignable to the interface's `Effect<void, …>`.
        if (assertFailure) yield* Effect.fail(assertFailure)
      }),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const question = Layer.succeed(
  QuestionV2.Service,
  QuestionV2.Service.of({
    ask: (input: QuestionV2.AskInput) =>
      Effect.sync(() => {
        captured = input
      }).pipe(Effect.andThen(reject ? Effect.fail(new QuestionV2.RejectedError()) : Effect.succeed([["Build"], []]))),
    reply: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, QuestionTool.node]), [
    [PermissionV2.node, permission],
    [QuestionV2.node, question],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

describe("QuestionTool", () => {
  it.effect("omits a denied built-in question and terminally settles a stale call", () =>
    Effect.gen(function* () {
      captured = undefined
      const denial = new PermissionV2.DeniedError({
        rules: [{ action: "question", resource: "*", effect: "deny" }],
      })
      assertFailure = denial
      const registry = yield* ToolRegistry.Service

      expect(yield* toolDefinitions(registry, [{ action: "question", resource: "*", effect: "deny" }])).toEqual([])
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question-denied", name: "question", input: { questions: [] } },
        }),
      ).toEqual({ result: { type: "error", value: PermissionV2.denialMessage(denial)! } })
      expect(capturedInput()).toBeUndefined()
      assertFailure = undefined
    }),
  )

  // The blanket `mapError` used to ignore its error and hardcode "Permission denied: question", so
  // every verdict collapsed into one sentence — a reject's user feedback erased, and with it the
  // deny-fast wording written to stop an unattended run retrying something that can never succeed.
  //
  // ⚠️ Pinned over EVERY member of `PermissionV2.Error`, not one specimen: `assert` may raise any of
  // the three and `denialMessage` answers all three, so a check over a single member would leave
  // the others free to collapse silently — the defect class ruling 1 names. The `reason` variants
  // are covered for the same reason (each is a DIFFERENT string from `denialMessage`); this is a
  // statement about what the absorber must not throw away, not a claim about which verdict this
  // action reaches in production.
  const denialCases = [
    {
      kind: "a policy denial",
      failure: new PermissionV2.DeniedError({ rules: [{ action: "question", resource: "*", effect: "deny" }] }),
      contains: "question",
    },
    {
      kind: "a deny-fast refusal with no answerer",
      failure: new PermissionV2.DeniedError({
        rules: [{ action: "question", resource: "*", effect: "deny" }],
        reason: "unattended-unanswerable",
      }),
      contains: "UNATTENDED",
    },
    { kind: "a plain user rejection", failure: new PermissionV2.RejectedError(), contains: "declined" },
    {
      // The clause `permission.ts` names by name: "including the user's optional reject feedback".
      kind: "a rejection carrying user feedback",
      failure: new PermissionV2.CorrectedError({ feedback: "just pick the default and move on" }),
      contains: "just pick the default and move on",
    },
  ] as const

  for (const { kind, failure, contains } of denialCases)
    it.effect(`${kind} keeps its own text instead of collapsing into the fallback`, () =>
      Effect.gen(function* () {
        captured = undefined
        reject = false
        assertFailure = failure
        const registry = yield* ToolRegistry.Service

        const expected = PermissionV2.denialMessage(failure)
        // Guard the instrument: if `denialMessage` ever returned undefined or the fallback wording,
        // the assertion below would pass while proving nothing.
        expect(typeof expected).toBe("string")
        expect(expected).not.toBe("Unable to ask the user")
        expect(expected).toContain(contains)

        expect(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-question-gated", name: "question", input: { questions: [] } },
          }),
        ).toEqual({ type: "error", value: expected })
        expect(capturedInput()).toBeUndefined()
        assertFailure = undefined
      }),
    )

  it.effect("NEGATIVE CONTROL: a non-permission failure gets the fallback, which never says 'denied'", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      // A vanished session, not a denial — `denialMessage` declines it, so the else arm must answer.
      // This is the ONE error that reaches the fallback, and it is the case the old hardcoded
      // "Permission denied: question" got actively WRONG (ruling 2 — a fault described falsely).
      assertFailure = new SessionV2.NotFoundError({ sessionID })
      const registry = yield* ToolRegistry.Service

      expect(PermissionV2.denialMessage(assertFailure)).toBeUndefined()
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question-vanished", name: "question", input: { questions: [] } },
        }),
      ).toEqual({ type: "error", value: "Unable to ask the user" })
      expect(capturedInput()).toBeUndefined()
      assertFailure = undefined
    }),
  )

  it.effect("registers question and projects user answers without a permission assertion", () =>
    Effect.gen(function* () {
      assertions.length = 0
      captured = undefined
      reject = false
      assertFailure = undefined
      const registry = yield* ToolRegistry.Service
      const questions = [
        {
          question: "What should happen?",
          header: "Action",
          options: [{ label: "Build", description: "Build it" }],
        },
        {
          question: "Which environment?",
          header: "Environment",
          options: [{ label: "Dev", description: "Development" }],
        },
      ]

      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["question"])
      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-question", name: "question", input: { questions } },
        }),
      ).toEqual({
        result: {
          type: "text",
          value:
            'User has answered your questions: "What should happen?"="Build", "Which environment?"="Unanswered". You can now continue with the user\'s answers in mind.',
        },
        output: {
          structured: { answers: [["Build"], []] },
          content: [
            {
              type: "text",
              text: 'User has answered your questions: "What should happen?"="Build", "Which environment?"="Unanswered". You can now continue with the user\'s answers in mind.',
            },
          ],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "question", resources: ["*"] }])
      expect(capturedInput()).toEqual({
        sessionID,
        questions,
        tool: { messageID: toolIdentity.assistantMessageID, callID: "call-question" },
      })
    }),
  )

  it.effect("does not invent tool ownership metadata without a durable registry source", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = false
      assertFailure = undefined
      const registryService = yield* ToolRegistry.Service

      yield* executeTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "question", input: { questions: [] } },
      })
      expect(capturedInput()).toEqual({
        sessionID,
        questions: [],
        tool: { messageID: toolIdentity.assistantMessageID, callID: "call-question" },
      })
    }),
  )

  it.effect("keeps dismissed questions out of model-facing output", () =>
    Effect.gen(function* () {
      captured = undefined
      reject = true
      assertFailure = undefined
      const registryService = yield* ToolRegistry.Service
      const fiber = yield* executeTool(registryService, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-question", name: "question", input: { questions: [] } },
      }).pipe(Effect.forkScoped)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
