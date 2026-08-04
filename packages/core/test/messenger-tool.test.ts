import { describe, expect, test } from "bun:test"
import nodeFs from "node:fs"
import nodePath from "node:path"
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
import { MODE_RULES } from "@novaclaw/core/session/config-resolve"
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
    expect(MessengerTool.buildModerationAct({ act: "delete", message: "m1" })).toEqual({
      act: "delete",
      messageID: "m1",
    })
    expect(MessengerTool.buildModerationAct({ act: "pin", message: "m2" })).toEqual({ act: "pin", messageID: "m2" })
    expect(MessengerTool.buildModerationAct({ act: "delete" })).toEqual({
      error: expect.stringContaining("message id"),
    })
    expect(MessengerTool.buildModerationAct({ act: "pin", message: "  " })).toEqual({
      error: expect.stringContaining("message id"),
    })
  })

  test("ban, kick, and mute require a user id; mute carries an optional seconds", () => {
    expect(MessengerTool.buildModerationAct({ act: "ban", user: "u9" })).toEqual({ act: "ban", userID: "u9" })
    expect(MessengerTool.buildModerationAct({ act: "kick", user: "u8" })).toEqual({ act: "kick", userID: "u8" })
    expect(MessengerTool.buildModerationAct({ act: "mute", user: "u7", seconds: 300 })).toEqual({
      act: "mute",
      userID: "u7",
      seconds: 300,
    })
    expect(MessengerTool.buildModerationAct({ act: "mute", user: "u7" })).toEqual({ act: "mute", userID: "u7" })
    expect(MessengerTool.buildModerationAct({ act: "ban" })).toEqual({ error: expect.stringContaining("user id") })
    // A fractional seconds floors to a whole second.
    expect(MessengerTool.buildModerationAct({ act: "mute", user: "u7", seconds: 90.7 })).toEqual({
      act: "mute",
      userID: "u7",
      seconds: 90,
    })
  })

  // Queue moderation (Reddit): approve puts a removed item back; lock closes the chat the op
  // already names, so it asks for no ids at all.
  test("approve needs the item; lock targets the chat and needs nothing", () => {
    expect(MessengerTool.buildModerationAct({ act: "approve", message: "t1_x" })).toEqual({
      act: "approve",
      messageID: "t1_x",
    })
    expect(MessengerTool.buildModerationAct({ act: "approve" })).toEqual({
      error: expect.stringContaining("message id"),
    })
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
const otherAccount = new Messenger.AccountInfo({
  id: Messenger.AccountID.make("msa_other"),
  driverID: "fake",
  label: "Other Account",
  enabled: true,
  settings: {},
})

/** Every `permission.assert` this tool made during the current test, in order. Module-level because
 *  the layer is built once per runtime and the tests run sequentially; `withPermission` resets it. */
type Asserted = { action: string; resources: readonly string[]; save?: readonly string[] }
let asserted: Asserted[] = []
/** The one action to DENY, if any. ⚠️ Denying by FAILING is the whole reason this mock exists: the
 *  real evaluator answers an ungated action with `ask`, which parks on `Deferred.await` until a human
 *  replies — in a test that is a wedge no `--timeout` reaps, so a permission test that "controls" a
 *  deny by removing it never finishes. A mock that fails returns immediately and provably. */
let denyAction: string | undefined

const permissionLayer = Layer.mock(PermissionV2.Service)({
  assert: (input) => {
    asserted.push({
      action: input.action,
      resources: input.resources,
      ...(input.save === undefined ? {} : { save: input.save }),
    })
    return input.action === denyAction
      ? Effect.fail(
          new PermissionV2.DeniedError({
            rules: [{ action: input.action, resource: input.resources[0] ?? "*", effect: "deny" }],
          }),
        )
      : Effect.void
  },
})

/** Reset the recorder and optionally arm a deny, for the length of `body`. */
const withPermission = <A, E, R>(options: { deny?: string }, body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    asserted = []
    denyAction = options.deny
    return body.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          denyAction = undefined
        }),
      ),
    )
  })

const storeLayer = Layer.mock(MessengerStore.Service)({
  listAccounts: () => Effect.succeed([account]),
  bindingsForSession: () => Effect.succeed([]),
})
/** A session whose chain carries an ACTIVE client binding — an untrusted correspondent is driving
 *  the turn. `HostExec.chainHasHostileBinding` walks the parent chain looking for exactly this. */
const hostileStoreLayer = Layer.mock(MessengerStore.Service)({
  listAccounts: () => Effect.succeed([account]),
  bindingsForSession: () =>
    Effect.succeed([
      new Messenger.BindingInfo({
        id: Messenger.BindingID.make("msb_client"),
        accountID: account.id,
        chatID: "4242",
        sessionID: sessionID as never,
        trust: "client",
        status: "active",
      }),
    ]),
})
const hostileTwoAccountStoreLayer = Layer.mock(MessengerStore.Service)({
  listAccounts: () => Effect.succeed([account, otherAccount]),
  bindingsForSession: () =>
    Effect.succeed([
      new Messenger.BindingInfo({
        id: Messenger.BindingID.make("msb_client_two_accounts"),
        accountID: account.id,
        chatID: "4242",
        sessionID: sessionID as never,
        trust: "client",
        status: "active",
      }),
    ]),
})
/** Accounts read fine; the BINDING table does not — so "is a stranger driving this turn?" has no
 *  answer. The pair with `storeLayer` is the negative control for the tri-state's middle value. */
const unreadableBindingsStoreLayer = Layer.mock(MessengerStore.Service)({
  listAccounts: () => Effect.succeed([account]),
  bindingsForSession: () =>
    Effect.fail(
      new MessengerStore.UnavailableError({
        read: `bindingsForSession(${sessionID})`,
        detail: "no such table: messenger_binding",
      }),
    ),
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
  Effect.fail(
    new MessengerStore.UnavailableError({ read: "listAccounts()", detail: "no such table: messenger_account" }),
  )
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
      // ⚠️ `get` must ANSWER, not merely exist. It is the `parentOf` half of the hostile-chain walk
      // (`HostExec.chainHasHostileBinding`), and that walk is handed both lookups WITHOUT a local
      // recovery on purpose — a mock that died here would take the turn down as a defect instead of
      // exercising the tri-state. `undefined` = "this session is the chain root", which it is.
      [SessionStore.node, Layer.mock(SessionStore.Service)({ get: () => Effect.succeed(undefined) })],
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
const itHostileChain = runtime(hostileStoreLayer)
const itHostileTwoAccounts = runtime(hostileTwoAccountStoreLayer)
const itUnreadableBindings = runtime(unreadableBindingsStoreLayer)

/** The permission resource every gate in the `send` path names: account, then chat. */
const CHAT_RESOURCE = `${account.id}:77`

const sendCall = (id: string, extra: Record<string, unknown> = {}) => ({
  sessionID,
  ...toolIdentity,
  call: {
    type: "tool-call" as const,
    id,
    name: MessengerTool.name,
    input: { op: "send", chat: "77", text: "on my way", ...extra },
  },
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
): Effect.Effect<A, E, R> => withGatewayHandle({ send }, body)

const withGatewayHandle = <A, E, R>(stub: object, body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    MessengerGatewayHandle.set(stub as never)
    return body.pipe(Effect.ensuring(Effect.sync(() => MessengerGatewayHandle.clear(stub as never))))
  })

const readCall = (id: string, input: Record<string, unknown>) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: MessengerTool.name, input },
})

describe("MessengerTool reads — session privacy scope", () => {
  itHostileTwoAccounts.effect("status hides every account outside the bound conversation", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, readCall("call-hostile-status", { op: "status" }))
      const text = String(result.value)

      expect(text).toContain(account.id)
      expect(text).toContain(`${account.id}:4242`)
      expect(text).not.toContain(otherAccount.id)
      expect(text).not.toContain(otherAccount.label)
    }),
  )

  itHostileChain.effect("a client-bound session cannot enumerate the account's other chats", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      let reads = 0
      const result = yield* withGatewayHandle(
        {
          chats: () => {
            reads += 1
            return Effect.succeed({ ok: true, chats: [] })
          },
        },
        executeTool(registry, readCall("call-hostile-chats", { op: "chats" })),
      )

      expect(reads).toBe(0)
      expect(String(result.value)).toContain("may read only that bound conversation")
    }),
  )

  itHostileChain.effect("a client-bound session reads its own chat and hard-denies another", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const reads: string[] = []
      const gateway = {
        history: (input: { chatID: string }) => {
          reads.push(input.chatID)
          return Effect.succeed({
            ok: true,
            messages: [{ senderName: "Client", outgoing: false, text: `message from ${input.chatID}`, at: 0 }],
          })
        },
      }

      const denied = yield* withGatewayHandle(
        gateway,
        executeTool(registry, readCall("call-hostile-other-history", { op: "history", chat: "77" })),
      )
      expect(reads).toEqual([])
      expect(String(denied.value)).toContain("Other accounts and chats stay private")

      const allowed = yield* withGatewayHandle(
        gateway,
        executeTool(registry, readCall("call-hostile-own-history", { op: "history", chat: "4242" })),
      )
      expect(reads).toEqual(["4242"])
      expect(String(allowed.value)).toContain("message from 4242")
    }),
  )

  itHostileChain.effect("attachment download cannot read outside the bound chat", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      let reads = 0
      const result = yield* withGatewayHandle(
        {
          attachment: () => {
            reads += 1
            return Effect.succeed({ ok: false, reason: "not reached" })
          },
        },
        executeTool(
          registry,
          readCall("call-hostile-other-download", {
            op: "download",
            chat: "77",
            message: "msg-secret",
          }),
        ),
      )

      expect(reads).toBe(0)
      expect(String(result.value)).toContain("Other accounts and chats stay private")
    }),
  )

  it.effect("an operator session retains mailbox-wide chat listing", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      let reads = 0
      const result = yield* withGatewayHandle(
        {
          chats: () => {
            reads += 1
            return Effect.succeed({
              ok: true,
              chats: [{ chatID: "77", kind: "dm", title: "Another chat", access: { proposed: "unknown" } }],
            })
          },
        },
        executeTool(registry, readCall("call-operator-chats", { op: "chats" })),
      )

      expect(reads).toBe(1)
      expect(String(result.value)).toContain("Another chat")
    }),
  )
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

  // ⚠️ THIS TEST USED TO SAY THE PRODUCT COULD NOT START A CONVERSATION AT ALL, and the intent it
  // carried is preserved rather than deleted. `SendOp` had no `initiate` field and the
  // `messenger.initiate` permission the gateway's comment cited existed nowhere in the tree, so
  // AGENTS.md #9(b) shipped as its *default* (never cold-start) with the other half — start one with
  // **explicit permission** and a stricter rate limit — unbuilt. The old comment named what wiring it
  // would owe: "the permission too, one that genuinely ASKS". That is what the tests below pin.
  //
  // Why it was safe to build now and not before: while the agent baseline opened with a catch-all
  // `{*,*,allow}`, a new `messenger.initiate` action would have been granted by a rule written before
  // it existed — a gate that grants itself, which ruling 2 forbids more strongly than the gap. B4c
  // removed the catch-all (`AMBIENT_SAFE_BASELINE` = read/explore/todowrite), and
  // `test/permission-baseline.test.ts` holds the `messenger.*` family to `ask`.

  it.effect("an ordinary send raises ONE gate and never asks the gateway to cold-start", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const asked: Record<string, unknown>[] = []
      const result = yield* withPermission(
        {},
        withGateway(
          (input) => {
            asked.push(input)
            return Effect.succeed({ kind: "sent" } as StubOutcome)
          },
          executeTool(registry, sendCall("call-send-no-initiate")),
        ),
      )
      expect(String(result.value)).toContain("Sent (paced at human typing speed).")
      expect(asked).toHaveLength(1)
      // The field EXISTS on the schema now, so "absent" is a decision this call made rather than a
      // shape it could not express — which is exactly why it still has to be pinned. A reply must
      // never spend a slot from the daily new-conversation bucket.
      expect(asked[0]).not.toHaveProperty("initiate")
      // …and it must not cost the user a second consent card either.
      expect(asserted.map((entry) => entry.action)).toEqual(["messenger.send"])
    }),
  )

  it.effect("`initiate: true` reaches the gateway ONLY after messenger.initiate is granted", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const asked: Record<string, unknown>[] = []
      const result = yield* withPermission(
        {},
        withGateway(
          (input) => {
            asked.push(input)
            return Effect.succeed({ kind: "sent" } as StubOutcome)
          },
          executeTool(registry, sendCall("call-send-initiate", { initiate: true })),
        ),
      )
      expect(String(result.value)).toContain("Sent (paced at human typing speed).")
      expect(asked).toHaveLength(1)
      expect(asked[0]).toHaveProperty("initiate", true)

      // BOTH gates, in this order. The initiate card is ADDITIONAL, never a replacement: a cold
      // start is also a send, so a user who denied `messenger.send` for this chat must not be
      // reachable through the initiate card instead — and conversely the `save: ["*"]` the send gate
      // offers cannot satisfy this one, because the action names differ and `Wildcard.match`
      // compares actions literally.
      expect(asserted).toEqual([
        { action: "messenger.send", resources: [CHAT_RESOURCE], save: ["*"] },
        { action: "messenger.initiate", resources: [CHAT_RESOURCE], save: [CHAT_RESOURCE] },
      ])
      // ⭐ The line that matters most in this file. `save` is what an "always allow" persists
      // (`PermissionV2.savedResources`), so `["*"]` here would turn one card about one person into a
      // standing grant to COLD-DM ANYONE, FOREVER. `tool/recipe.ts` scoped `save` to a single slug
      // for the same reason; this scopes it to a single chat.
      const initiate = asserted.find((entry) => entry.action === "messenger.initiate")
      expect(initiate?.save).toEqual([CHAT_RESOURCE])
      expect(initiate?.save).not.toContain("*")
    }),
  )

  it.effect("a DENIED messenger.initiate sends nothing at all", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const asked: Record<string, unknown>[] = []
      const result = yield* withPermission(
        { deny: "messenger.initiate" },
        withGateway(
          (input) => {
            asked.push(input)
            return Effect.succeed({ kind: "sent" } as StubOutcome)
          },
          executeTool(registry, sendCall("call-send-initiate-denied", { initiate: true })),
        ),
      )
      // Ruling 2 — a failed mutation never reports success. The gateway was never reached, so no
      // message was paced, no slot was spent, and the model is told the truth about why.
      expect(asked).toHaveLength(0)
      expect(result.type).toBe("error")
      expect(String(result.value)).toContain("Permission denied")
      expect(String(result.value)).not.toContain("Sent (paced")
      // The send gate was still consulted first — the deny under test is the initiate one.
      expect(asserted.map((entry) => entry.action)).toEqual(["messenger.send", "messenger.initiate"])
    }),
  )
})

// ── the correspondent can never trigger the operator's permission ──────────────────────────────
// AGENTS.md #9(b) says starting a conversation needs EXPLICIT PERMISSION, and the standing decision
// *System commands are the OPERATOR's surface, never the correspondent's* says whose. A remote
// human's message is evaluated by the model, and the model acts through these very tools — so a
// client or audience chat could otherwise talk the agent into cold-DMing a third party on the
// user's real account, which is precisely the havoc principle 9 exists to prevent. A consent card
// is not an adequate answer to that (it would ask the operator to approve words a stranger wrote),
// so a hostile chain is refused BEFORE any card is raised.

describe("MessengerTool send — initiation from an untrusted chain", () => {
  itHostileChain.effect("a client/audience chain cannot initiate, and is never even asked", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const asked: Record<string, unknown>[] = []
      const result = yield* withPermission(
        {},
        withGateway(
          (input) => {
            asked.push(input)
            return Effect.succeed({ kind: "sent" } as StubOutcome)
          },
          executeTool(registry, sendCall("call-send-hostile-initiate", { initiate: true })),
        ),
      )
      expect(String(result.value)).toContain("client or an audience")
      expect(String(result.value)).toContain("Nothing was sent")
      expect(asked).toHaveLength(0)
      // Deny-fast: not one consent card. A card here would put the stranger's request in front of
      // the operator wearing the product's own voice.
      expect(asserted).toEqual([])
    }),
  )

  itHostileChain.effect("POSITIVE CONTROL: the same untrusted chain may still REPLY", () =>
    Effect.gen(function* () {
      // Without this the test above would pass just as well if the refusal had swallowed every send
      // from a bound client chat — which would break the product's main job (answering the people
      // who wrote to you) while looking like security.
      const registry = yield* ToolRegistry.Service
      const asked: Record<string, unknown>[] = []
      const result = yield* withPermission(
        {},
        withGateway(
          (input) => {
            asked.push(input)
            return Effect.succeed({ kind: "sent" } as StubOutcome)
          },
          executeTool(registry, sendCall("call-send-hostile-reply")),
        ),
      )
      expect(String(result.value)).toContain("Sent (paced at human typing speed).")
      expect(asked).toHaveLength(1)
      expect(asserted.map((entry) => entry.action)).toEqual(["messenger.send"])
    }),
  )

  itUnreadableBindings.effect("an unreadable binding table is `unavailable`, not a claim about a chat", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const asked: Record<string, unknown>[] = []
      const result = yield* withPermission(
        {},
        withGateway(
          (input) => {
            asked.push(input)
            return Effect.succeed({ kind: "sent" } as StubOutcome)
          },
          executeTool(registry, sendCall("call-send-unknown-initiate", { initiate: true })),
        ),
      )
      const text = String(result.value)
      // Ruling 2 in both directions: name the fault we HAVE (the database), never the one we have
      // not established (a stranger driving this session).
      expect(text).toContain("messenger database can't be read")
      expect(text).not.toContain("client or an audience")
      // …and the `unavailable` horizon, so a small model stops retrying.
      expect(text).toContain("will not help")
      expect(asked).toHaveLength(0)
      expect(asserted).toEqual([])
    }),
  )
})

describe("MessengerTool.initiationRefusal", () => {
  // The pure collapse point, unit-tested so the three answers cannot quietly become two. Synchronous
  // by construction — no permission service, no gateway, nothing that can park.
  test("only a chain read end to end with nothing untrusted on it may initiate", () => {
    expect(MessengerTool.initiationRefusal(false)).toBeUndefined()
    expect(MessengerTool.initiationRefusal(true)?.outcome).toBe("failed")
    // ⚠️ `"unknown"` refuses, exactly as it does at the jail gate. An unanswerable containment
    // question is not a licence to write to a stranger on the user's real account.
    expect(MessengerTool.initiationRefusal("unknown")?.outcome).toBe("unavailable")
  })

  test("the two refusals never describe each other's fault", () => {
    // The failure this guards against is a single shared sentence: "we couldn't check, so no" reads
    // to a model as "a stranger is driving this session", which is a claim about a person invented
    // from a database fault (ruling 2).
    expect(MessengerTool.initiationRefusal(true)!.message).not.toContain("can't be read")
    expect(MessengerTool.initiationRefusal("unknown")!.message).not.toContain("client or an audience")
    // Both must say plainly that nothing went out — a refusal a model reads as ambiguous gets
    // relayed to the user as "I may have messaged them".
    expect(MessengerTool.initiationRefusal(true)!.message).toContain("Nothing was sent")
    expect(MessengerTool.initiationRefusal("unknown")!.message).toContain("nothing was sent")
  })
})

// ── the premise the whole gate rests on ────────────────────────────────────────────────────────
// A permission is only a gate if the answer defaults to "ask a human". `messenger.initiate` is a
// brand-new action name, so NOTHING we compile mentions it, and what it resolves to is therefore
// decided entirely by the fall-through. That is exactly what v0.2.0 B4c changed, and it is the
// reason this feature could be built now and not before — so it gets its own check here rather than
// being taken on trust from another file's ledger.

describe("messenger.initiate is granted by nothing we compile", () => {
  test("the ambient-safe baseline plus any mode overlay still leaves it at `ask`", () => {
    for (const mode of ["plan", "ask", "surgical", "bypass", "yolo"] as const)
      expect({
        mode,
        effect: PermissionV2.evaluate(
          "messenger.initiate",
          CHAT_RESOURCE,
          PermissionV2.AMBIENT_SAFE_BASELINE,
          MODE_RULES[mode],
        ).effect,
      }).toEqual({ mode, effect: "ask" })
  })

  test("NEGATIVE CONTROL: the pre-B4c catch-all would have made this gate grant itself", () => {
    // Restore the one rule B4c removed, in the position it used to hold. The assert would then
    // succeed with nobody consulted — a cold-start gate that permits every cold start, which is the
    // false promise ruling 2 forbids more strongly than it minds a missing feature.
    const preB4c = [{ action: "*", resource: "*", effect: "allow" as const }, ...PermissionV2.AMBIENT_SAFE_BASELINE]
    expect(PermissionV2.evaluate("messenger.initiate", CHAT_RESOURCE, preB4c, MODE_RULES.bypass).effect).toBe("allow")
  })
})

// ── the cross-file half: who may pass `initiate` at all ────────────────────────────────────────
// `gateway.send({ initiate })` is the enforcement point, and it is only as good as the claim that
// the gated tool is its ONLY caller. That claim is about code in other files, which is ruling 1's
// defect class — it compiles green the moment a third file starts passing the flag. So it is a
// ledger: shrink-only in spirit, and a fourth entry has to be added here deliberately.

const SRC_DIR = nodePath.resolve(import.meta.dir, "..", "src")

/** Every file in a tree whose text matches `word`, as tree-relative POSIX paths. */
const filesMatching = (files: readonly { readonly path: string; readonly text: string }[], word: RegExp): string[] =>
  files
    .filter((file) => word.test(file.text))
    .map((file) => file.path)
    .sort()

const sourceFiles = (dir: string, base = dir): { path: string; text: string }[] =>
  nodeFs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = nodePath.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full, base)
    if (!entry.name.endsWith(".ts")) return []
    return [{ path: nodePath.relative(base, full).replaceAll("\\", "/"), text: nodeFs.readFileSync(full, "utf8") }]
  })

/** `\b` on both sides so "initiated"/"initiates" in unrelated prose is not counted. */
const INITIATE = /\binitiate\b/

const INITIATE_FILES: readonly string[] = [
  // The enforcement point: the flag, the cold-start default and the daily bucket.
  "messenger/gateway.ts",
  // The gate: `SendOp.initiate`, `initiationRefusal`, and the `messenger.initiate` assert.
  "tool/messenger.ts",
]

describe("only the gated tool may ask the gateway to cold-start", () => {
  const files = sourceFiles(SRC_DIR)

  test("the scan can see the source tree at all", () => {
    // Without this a moved directory empties every list below and turns the ledger into a
    // tautology that passes forever.
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((file) => file.path === "tool/messenger.ts")).toBe(true)
  })

  test("no third file in the kernel speaks of initiating a conversation", () => {
    expect(filesMatching(files, INITIATE)).toEqual([...INITIATE_FILES].sort())
  })

  test("NEGATIVE CONTROL: a new call site is what the sweep reports", () => {
    const rogue = [
      ...files,
      { path: "server/rogue.ts", text: "gateway.send({ accountID, chatID, text, initiate: true })" },
    ]
    expect(filesMatching(rogue, INITIATE)).toEqual([...INITIATE_FILES, "server/rogue.ts"].sort())
    // …and the word-boundary is doing real work: prose about a UI-initiated delete must not trip it.
    expect(filesMatching([{ path: "x.ts", text: "// UI-initiated deletes notify locally" }], INITIATE)).toEqual([])
  })
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
