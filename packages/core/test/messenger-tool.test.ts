import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Location } from "@novaclaw/core/location"
import { LocationMutation } from "@novaclaw/core/location-mutation"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGatewayHandle } from "@novaclaw/core/messenger/gateway-handle"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionStore } from "@novaclaw/core/session/store"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { MessengerTool } from "@novaclaw/core/tool/messenger"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

// The `messenger` tool's pure helpers (notes/messenger-plan.md §4). buildModerationAct maps the flat
// op the model emits onto the driver ModerationAct union, validating that each act carries the target
// it needs (delete/pin → a message id; ban/kick/mute → a user id) with a legible error otherwise.

describe("MessengerTool.buildModerationAct", () => {
  test("delete and pin require a message id", () => {
    expect(MessengerTool.buildModerationAct({ act: "delete", message: "m1" })).toEqual({ act: "delete", messageID: "m1" })
    expect(MessengerTool.buildModerationAct({ act: "pin", message: "m2" })).toEqual({ act: "pin", messageID: "m2" })
    expect(MessengerTool.buildModerationAct({ act: "delete" })).toEqual({ error: expect.stringContaining("message id") })
    expect(MessengerTool.buildModerationAct({ act: "pin", message: "  " })).toEqual({ error: expect.stringContaining("message id") })
  })

  test("ban, kick, and mute require a user id; mute carries an optional seconds", () => {
    expect(MessengerTool.buildModerationAct({ act: "ban", user: "u9" })).toEqual({ act: "ban", userID: "u9" })
    expect(MessengerTool.buildModerationAct({ act: "kick", user: "u8" })).toEqual({ act: "kick", userID: "u8" })
    expect(MessengerTool.buildModerationAct({ act: "mute", user: "u7", seconds: 300 })).toEqual({ act: "mute", userID: "u7", seconds: 300 })
    expect(MessengerTool.buildModerationAct({ act: "mute", user: "u7" })).toEqual({ act: "mute", userID: "u7" })
    expect(MessengerTool.buildModerationAct({ act: "ban" })).toEqual({ error: expect.stringContaining("user id") })
    // A fractional seconds floors to a whole second.
    expect(MessengerTool.buildModerationAct({ act: "mute", user: "u7", seconds: 90.7 })).toEqual({ act: "mute", userID: "u7", seconds: 90 })
  })

  // Queue moderation (Reddit): approve puts a removed item back; lock closes the chat the op
  // already names, so it asks for no ids at all.
  test("approve needs the item; lock targets the chat and needs nothing", () => {
    expect(MessengerTool.buildModerationAct({ act: "approve", message: "t1_x" })).toEqual({ act: "approve", messageID: "t1_x" })
    expect(MessengerTool.buildModerationAct({ act: "approve" })).toEqual({ error: expect.stringContaining("message id") })
    expect(MessengerTool.buildModerationAct({ act: "lock" })).toEqual({ act: "lock" })
  })

  // On a spam wave, banning the account while its posts stay up leaves the cleanup to a human —
  // `seconds` on a ban is the purge window (Discord deletes that member's recent messages).
  test("ban with seconds purges that member's recent messages", () => {
    expect(MessengerTool.buildModerationAct({ act: "ban", user: "spammer", seconds: 3600 })).toEqual({
      act: "ban",
      userID: "spammer",
      purgeSeconds: 3600,
    })
    expect(MessengerTool.buildModerationAct({ act: "ban", user: "spammer", seconds: -5 })).toEqual({
      act: "ban",
      userID: "spammer",
      purgeSeconds: 0,
    })
  })
})

// ── the send op's honesty, end of the chain ────────────────────────────────────────────────────
// The gateway now answers `send` with the driver's verdict (messenger-gateway.test.ts proves that);
// this is the other half of the same invariant — what the MODEL is told. A refused send must reach
// it as the driver's reason, and only a real delivery may say "Sent". The gateway is stubbed here
// deliberately: this pins the tool's rendering of both outcomes so a later edit cannot quietly
// collapse them back into one cheerful message.

const sessionID = SessionV2.ID.make("ses_messenger_tool_test")
const account = new Messenger.AccountInfo({
  id: Messenger.AccountID.make("msa_test"),
  driverID: "fake",
  label: "Test",
  enabled: true,
  settings: {},
})

const permissionLayer = Layer.mock(PermissionV2.Service)({ assert: () => Effect.void })
const storeLayer = Layer.mock(MessengerStore.Service)({
  listAccounts: () => Effect.succeed([account]),
  bindingsForSession: () => Effect.succeed([]),
})
/** A store that ANSWERS, with nothing in it — the positive control for the unreadable one below.
 *  These two differ in exactly one way, and the tool must say two different things about them. */
const emptyStoreLayer = Layer.mock(MessengerStore.Service)({
  listAccounts: () => Effect.succeed([]),
  bindingsForSession: () => Effect.succeed([]),
})
/** A store that cannot answer. The `UnavailableError` is real, not a bare `Effect.fail(…)`, so the
 *  tool is exercised against the exact failure `messenger-store.test.ts` proves sqlite produces. */
const unreadable = () =>
  Effect.fail(new MessengerStore.UnavailableError({ read: "listAccounts()", detail: "no such table: messenger_account" }))
const unreadableStoreLayer = Layer.mock(MessengerStore.Service)({
  listAccounts: unreadable,
  bindingsForSession: unreadable,
})
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) })),
)

const runtime = (store: typeof storeLayer) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, MessengerTool.node]), [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [PermissionV2.node, permissionLayer],
      [Location.node, locationLayer],
      [LocationMutation.node, Layer.mock(LocationMutation.Service)({})],
      [SessionStore.node, Layer.mock(SessionStore.Service)({})],
      [MessengerStore.node, store],
      [
        MessengerDrivers.node,
        Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([]))),
      ],
    ]),
  )

const it = runtime(storeLayer)
const itEmptyStore = runtime(emptyStoreLayer)
const itBrokenStore = runtime(unreadableStoreLayer)

const sendCall = (id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: MessengerTool.name, input: { op: "send", chat: "77", text: "on my way" } },
})

/** The gateway's `SendOutcome`, restated structurally rather than imported: this module
 *  must never pull `messenger/gateway.ts` into its graph (the tool itself may not, and a
 *  test that did would stop proving the tool works without it). Three arms, `kind`-tagged —
 *  a stub still shaped `{ ok: boolean }` would silently take the "Sent" branch. */
type StubOutcome = { kind: "sent" } | { kind: "refused"; reason: string } | { kind: "unavailable"; reason: string }

/** Stub the ONE gateway handle the tool reads at call time, for the length of `body`. */
const withGateway = <A, E, R>(
  send: (input: Record<string, unknown>) => Effect.Effect<StubOutcome>,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const stub = { send } as never
    MessengerGatewayHandle.set(stub)
    return body.pipe(Effect.ensuring(Effect.sync(() => MessengerGatewayHandle.clear(stub))))
  })

describe("MessengerTool send", () => {
  it.effect("a refused send reaches the model as the driver's reason, not 'Sent'", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const refused = yield* withGateway(
        () => Effect.succeed({ kind: "refused", reason: "the platform refused it: message too long" } as StubOutcome),
        executeTool(registry, sendCall("call-send-refused")),
      )
      expect(refused.type).toBe("text")
      expect(String(refused.value)).toContain("the platform refused it: message too long")
      expect(String(refused.value)).not.toContain("Sent (paced")

      const sent = yield* withGateway(
        () => Effect.succeed({ kind: "sent" } as StubOutcome),
        executeTool(registry, sendCall("call-send-ok")),
      )
      expect(String(sent.value)).toContain("Sent (paced at human typing speed).")
    }),
  )

  // ⚠️ THE PRODUCT CANNOT START A CONVERSATION, and this is the mechanical statement of it.
  // `gateway.send` takes an `initiate` flag that lifts the cold-start refusal and spends a slot from
  // the daily bucket — but nothing reaches it: `SendOp` has no `initiate` field, and the
  // `messenger.initiate` permission the gateway's comment used to cite exists nowhere in the tree.
  // That is AGENTS.md #9(b)'s *default* (never cold-start) but only half of its rule; the other
  // half — start one with explicit permission and a stricter limit — is UNIMPLEMENTED. Wiring
  // `initiate` through turns this test red, so whoever does must also ship the permission (one that
  // genuinely ASKS — the agent baseline's catch-all `* → allow` would otherwise make the assert a
  // no-op) and correct the comments that describe it.
  it.effect("the tool never asks the gateway to cold-start — `initiate` is not wired", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const asked: Record<string, unknown>[] = []
      const call = sendCall("call-send-no-initiate")
      yield* withGateway(
        (input) => {
          asked.push(input)
          return Effect.succeed({ kind: "sent" } as StubOutcome)
        },
        executeTool(registry, call),
      )
      expect(asked).toHaveLength(1)
      expect(asked[0]).not.toHaveProperty("initiate")

      // …and the model cannot smuggle one past the schema either.
      const smuggled = {
        ...call,
        call: { ...call.call, id: "call-send-smuggle", input: { ...call.call.input, initiate: true } },
      }
      yield* withGateway(
        (input) => {
          asked.push(input)
          return Effect.succeed({ kind: "sent" } as StubOutcome)
        },
        executeTool(registry, smuggled),
      ).pipe(Effect.ignore)
      expect(asked.every((input) => !("initiate" in input))).toBe(true)
    }),
  )
})

// ── the dead-letter class, as the MODEL experiences it ─────────────────────────────────────────
// `status` is the op this tool's own description tells a model to call FIRST ("do NOT assume you
// have no access — START by calling {"op":"status"}"). An unreadable messenger database used to
// reach it as "No messenger accounts are set up. Ask the user to add one in Settings → Messengers"
// — a sqlite fault rendered as a claim about the user's setup, on the one surface a model consults
// before concluding it has no messaging at all. It would then tell the user to go set up an
// account they already have.
//
// The two store doubles below differ in exactly ONE way — one answers with an empty list, the
// other cannot answer — and the pair is the negative control: a change that collapses them back
// together fails whichever leg it collapsed into.

const statusCall = (id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: MessengerTool.name, input: { op: "status" } },
})

describe("MessengerTool status", () => {
  itEmptyStore.effect("a store that answers with nothing still says the accounts are not set up", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, statusCall("call-status-empty"))
      // The positive control. This sentence is TRUE for an empty store, which is exactly why it
      // must not also be what a broken one says.
      expect(String(result.value)).toContain("No messenger accounts are set up")
      expect(String(result.value)).not.toContain("could not be read")
    }),
  )

  itBrokenStore.effect("a store that CANNOT answer names itself instead of blaming the user's setup", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, statusCall("call-status-unreadable"))
      const text = String(result.value)
      expect(text).toContain("messenger database could not be read")
      // The lie has to be GONE, not merely joined by a truer sentence beside it: a model that reads
      // "no accounts are set up" acts on it regardless of what follows.
      expect(text).not.toContain("No messenger accounts are set up")
      // …and the horizon a small model cannot supply for itself (AGENTS.md, the Juvenile Harness
      // thesis): retrying is not the move, telling the user is.
      expect(text).toContain("will not help")
    }),
  )
})

describe("MessengerTool.modelText", () => {
  // The ONE place the three outcomes become the sentence a model reads. Pinned here rather than
  // left to whoever edits the tool next, because the failure is silent: a model told only "the
  // database could not be read" retries the same call until its budget is gone.
  test("only the unavailable arm carries the do-not-retry horizon", () => {
    expect(MessengerTool.modelText({ outcome: "ok", message: "Sent." })).toBe("Sent.")
    expect(MessengerTool.modelText({ outcome: "failed", message: "That chat is already bound." })).toBe(
      "That chat is already bound.",
    )
    const unavailable = MessengerTool.modelText({ outcome: "unavailable", message: "The database could not be read." })
    expect(unavailable).toContain("The database could not be read.")
    expect(unavailable).toContain("Nothing was sent and nothing was changed.")
    expect(unavailable).toContain("will not help")
  })
})
