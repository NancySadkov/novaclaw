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
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) })),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, MessengerTool.node]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [PermissionV2.node, permissionLayer],
    [Location.node, locationLayer],
    [LocationMutation.node, Layer.mock(LocationMutation.Service)({})],
    [SessionStore.node, Layer.mock(SessionStore.Service)({})],
    [MessengerStore.node, storeLayer],
    [
      MessengerDrivers.node,
      Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([]))),
    ],
  ]),
)

const sendCall = (id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: MessengerTool.name, input: { op: "send", chat: "77", text: "on my way" } },
})

/** Stub the ONE gateway handle the tool reads at call time, for the length of `body`. */
const withGateway = <A, E, R>(
  send: () => Effect.Effect<{ ok: boolean; reason?: string }>,
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
        () => Effect.succeed({ ok: false, reason: "the platform refused it: message too long" }),
        executeTool(registry, sendCall("call-send-refused")),
      )
      expect(refused.type).toBe("text")
      expect(String(refused.value)).toContain("the platform refused it: message too long")
      expect(String(refused.value)).not.toContain("Sent (paced")

      const sent = yield* withGateway(
        () => Effect.succeed({ ok: true }),
        executeTool(registry, sendCall("call-send-ok")),
      )
      expect(String(sent.value)).toContain("Sent (paced at human typing speed).")
    }),
  )
})
