import { describe, expect, test } from "bun:test"
import type { Cause } from "effect"
import { Duration, Effect, Layer, Queue, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Offline } from "@novaclaw/core/offline"
import { SessionV2 } from "@novaclaw/core/session"
import { MessengerDriver } from "@novaclaw/core/messenger/driver"
import { IrcDriver } from "@novaclaw/core/messenger/driver/irc"
import type { IrcSocket, IrcSocketFactory } from "@novaclaw/core/messenger/driver/irc"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerPace } from "@novaclaw/core/messenger/pace"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { testEffect } from "./lib/effect"

/**
 * **AGENTS.md design principle 9 — "play nice with messaging providers" — as executable claims.**
 * Two faults, both of which end with a real person's account flagged or banned, and neither of
 * which any existing test could see:
 *
 *  1. **A per-connection message id makes the account SILENTLY DEAF after a reconnect.** The
 *     durable inbound ledger keys on `(account, chat, message_id)` and skips anything already
 *     routed, so an id minted by a counter that restarts at 1 collides with the previous session's
 *     rows and the first N messages of every new session are dropped as replays. Nothing logs.
 *  2. **Gateway commands were handled ABOVE the flood cap and above the stranger-silence
 *     default.** One stranger looping a slash command drew an unbounded stream of automated
 *     replies out of the account — and because outbound is serialized through a single global
 *     "hand", the burst also stalled every OTHER account's outbound for its whole duration.
 */

// ── the fake driver ────────────────────────────────────────────────────────────────────────────
// One driver serving MANY accounts, because half of what is under test here is cross-account: a
// flood on one account must not take another account's voice away. So queues are per account and
// `sent` is one shared, ordered log — the order IS the observation.

const CAPS: Messenger.Capabilities = {
  listChats: "none",
  files: { up: false, down: false },
  edits: false,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: 1000,
}

type Sent = { readonly accountID: string; readonly chatID: string; readonly text: string | undefined }

const makeFakeDriver = () => {
  const state = {
    queues: new Map<string, Queue.Queue<MessengerDriver.InboundEvent, Cause.Done>>(),
    sent: [] as Sent[],
  }
  const driver: MessengerDriver.Driver = {
    id: "fake",
    meta: { id: "fake", name: "Fake", icon: "chat", auth: "none", settings: [], capabilities: CAPS },
    capabilities: () => CAPS,
    connect: (ctx) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<MessengerDriver.InboundEvent, Cause.Done>()
        state.queues.set(ctx.account.id, queue)
        return {
          inbound: Stream.fromQueue(queue),
          send: (chatID, message) =>
            Effect.sync(() => {
              state.sent.push({ accountID: ctx.account.id, chatID, text: message.text })
              return { messageID: "m" + state.sent.length }
            }),
          history: () => Effect.succeed([]),
        } satisfies MessengerDriver.Connection
      }),
  }
  return { driver, state }
}

const makeSessionMock = () => {
  const prompts: { sessionID: string; text: string }[] = []
  const layer = Layer.mock(SessionV2.Service, {
    prompt: (input: { sessionID: string; prompt: { text: string } }) =>
      Effect.sync(() => {
        prompts.push({ sessionID: input.sessionID, text: input.prompt.text })
        return undefined as never
      }),
    list: () => Effect.succeed([{ id: "ses_alpha", title: "Fix the login bug" }] as never),
    get: (sessionID: string) =>
      Effect.suspend(() =>
        sessionID === "ses_alpha"
          ? Effect.succeed({ id: "ses_alpha", title: "Fix the login bug", location: { directory: "." } } as never)
          : Effect.fail({ _tag: "Session.NotFoundError" } as never),
      ),
    // `revert` is a nested OBJECT on the service, not a method, so the partial-mock inference that
    // stubs absent functions cannot supply it — omitting it is a type error, not a silent hole.
    // Declared rather than cast away with `as never` (which is how the sibling suite escapes it), so
    // that a member added to `revert` later is a typecheck failure here instead of a mock that
    // quietly answers for a surface it no longer covers. Nothing in this file touches it; if
    // something starts to, it dies loudly rather than returning a plausible value.
    revert: {
      stage: () => Effect.die("account-safety: revert.stage is not part of this test"),
      clear: () => Effect.die("account-safety: revert.clear is not part of this test"),
      commit: () => Effect.die("account-safety: revert.commit is not part of this test"),
    } as never,
  })
  return { prompts, layer }
}

const fake = makeFakeDriver()
const session = makeSessionMock()

/**
 * ⏱ **The pacer is deliberately NOT instant here**, unlike in `messenger-gateway.test.ts`. Half of
 * defect 2 is that the flood holds the ONE global outbound permit, and a pacer whose sleep is a
 * no-op cannot express that: every send would be free and a completely unfixed gateway would still
 * answer the second account promptly. So each outbound costs a fixed, small slice of real time and
 * the cross-account test measures how long the innocent account waited for its own reply.
 */
const PACE_STEP_MS = 25

const REPLACEMENTS = [
  [
    MessengerDrivers.node,
    // ⚠️ The IRC driver is deliberately NOT registered with the gateway. Its half of this file
    // drives `IrcDriver.make(fakeSocket)` directly, and an installed `irc` driver would let a
    // stray enabled account dial a real socket out of the test suite.
    Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([fake.driver]))),
  ],
  [
    Offline.node,
    Layer.mock(Offline.Service)({
      policy: { enabled: false, allowedHosts: new Set<string>() },
      check: () => ({ allowed: true }) as const,
      egressEnv: () => undefined,
      manifest: () => ({ enabled: false, active: 0, total: 9, layers: [] }),
    }),
  ],
  [SessionV2.node, session.layer],
  [
    MessengerPace.node,
    // The pacer's own `gap` sleep arrives as 0; only the typing delay is charged, so one outbound
    // costs exactly PACE_STEP_MS of the single global hand.
    MessengerPace.layerWith({
      sleep: (ms: number) => (ms === 0 ? Effect.void : Effect.sleep(Duration.millis(PACE_STEP_MS))),
    }),
  ],
] satisfies LayerNode.Replacements

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      FSUtil.node,
      Global.node,
      MessengerStore.node,
      MessengerGateway.node,
    ]),
    REPLACEMENTS,
  ),
)

let seq = 0
const message = (
  chatID: string,
  opts: { text: string; sender?: string; kind?: Messenger.ChatKind },
): MessengerDriver.InboundEvent => ({
  kind: "message",
  chat: { chatID, kind: opts.kind ?? "dm", title: "Chat " + chatID },
  messageID: "msg-" + ++seq,
  sender: { id: opts.sender ?? "u1", name: "Somebody", isSelf: false },
  text: opts.text,
  at: Date.now(),
})

const eventually = <A, E>(effect: Effect.Effect<A, E>, predicate: (value: A) => boolean, label: string, rounds = 200) =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds; round++) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep(Duration.millis(25))
    }
    return yield* Effect.die(`timeout waiting for ${label}`)
  })

/**
 * Bring N accounts online together. ⚠️ Created and reloaded in ONE pass on purpose: a second
 * `reload()` reconciles every account, and an account it reconnects gets a NEW inbound queue — a
 * handle grabbed before that reload would then be offering messages into a stream nobody reads,
 * and the test would fail as a timeout with no hint of why.
 */
const online = (...labels: readonly string[]) =>
  Effect.gen(function* () {
    const store = yield* MessengerStore.Service
    const gateway = yield* MessengerGateway.Service
    const accounts: Messenger.AccountInfo[] = []
    for (const label of labels)
      accounts.push(yield* store.createAccount({ driverID: "fake", label, enabled: true, settings: {} }))
    yield* gateway.reload()
    yield* eventually(
      gateway.status(),
      (map) => accounts.every((account) => map.get(account.id)?.state === "connected"),
      `${labels.join(" + ")} connected`,
    )
    return {
      store,
      gateway,
      accounts: accounts.map((account) => {
        const queue = fake.state.queues.get(account.id)
        if (queue === undefined) throw new Error(`no queue for ${account.label}`)
        return { account, queue }
      }),
    }
  })

// ── 1. the IRC message id ──────────────────────────────────────────────────────────────────────

const makeFakeSocket = () => {
  let current: { push: (...lines: string[]) => void } | undefined
  const factory: IrcSocketFactory = async () => {
    let pending: string[] = []
    let waiter: ((lines: readonly string[]) => void) | undefined
    const push = (...lines: string[]) => {
      pending.push(...lines)
      if (waiter !== undefined) {
        const resolve = waiter
        waiter = undefined
        const batch = pending
        pending = []
        resolve(batch)
      }
    }
    current = { push }
    const socket: IrcSocket = {
      send: async (line) => {
        if (line.startsWith("USER ")) push(":server 001 nova :Welcome")
      },
      lines: () =>
        new Promise((resolve) => {
          if (pending.length > 0) {
            const batch = pending
            pending = []
            resolve(batch)
            return
          }
          waiter = resolve
        }),
      close: async () => {},
    }
    return socket
  }
  // A FRESH socket per connect — the reconnect must be a real one, not the same object handed back.
  return { factory, push: (...lines: string[]) => current?.push(...lines) }
}

const IRC_SETTINGS = { host: "irc.example.net", port: "6697", nick: "nova", channels: "#support" }

const ircAccount = { id: "msa_probe", driverID: "irc", label: "irc", enabled: true, settings: IRC_SETTINGS }

/** One IRC connection: open it, feed `lines`, collect `count` inbound ids, close the scope. */
const ircSession = (factory: IrcSocketFactory, push: (...lines: string[]) => void, lines: string[], count: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* IrcDriver.make(factory).connect({
        account: ircAccount as never as Messenger.AccountInfo,
        secret: undefined,
        cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
      })
      push(...lines)
      const ids: string[] = []
      yield* connection.inbound.pipe(
        Stream.take(count),
        // `InboundEvent` is a union and only some arms carry an id — a `member` or `presence` event
        // has none. Narrowing rather than casting keeps this honest: if the driver ever emits a
        // non-message arm here the count assertion fails loudly instead of collecting `undefined`.
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.kind === "message" || event.kind === "edited" || event.kind === "deleted")
              ids.push(event.messageID)
          }),
        ),
      )
      return ids
    }),
  )

describe("messenger account safety — the IRC message id", () => {
  it.live("🔴 an id derived from the LINE survives a reconnect; a per-connection counter does not", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      // Disabled: this account exists only to give the ledger rows an owner. The driver is exercised
      // directly against the fake socket below, and an ENABLED account would be reconciled by the
      // gateway reloads further down this file.
      const account = yield* store.createAccount({ driverID: "irc", label: "irc-ids", enabled: false, settings: {} })
      const { factory, push } = makeFakeSocket()
      const claim = (messageID: string) => store.claimInbound({ accountID: account.id, chatID: "#support", messageID })
      const routed = (messageID: string) =>
        store.markInboundRouted({ accountID: account.id, chatID: "#support", messageID, at: Date.now() })

      // Session one: two messages, delivered and marked routed exactly as the gateway would.
      const before = yield* ircSession(
        factory,
        push,
        [":alice!u@h PRIVMSG #support :the printer is on fire", ":bob!u@h PRIVMSG #support :again?"],
        2,
      )
      expect(before).toHaveLength(2)
      for (const id of before) {
        expect(yield* claim(id)).toBe("fresh")
        yield* routed(id)
      }

      // 🔴 The CONTROL, and the test is hollow without it: the ledger really does refuse a repeat.
      // If this said "fresh", the assertion below would pass on a gateway that had never learned to
      // deduplicate at all, and the deafness it describes could not happen either.
      expect(yield* claim(before[0]!)).toBe("delivered")

      // The socket drops and the driver reconnects — a brand-new connection, brand-new scope. Two
      // NEW messages arrive. Under the old per-connection counter these are `irc-1`/`irc-2` again,
      // they claim as `delivered`, and the account is deaf to both with nothing logged anywhere.
      const after = yield* ircSession(
        factory,
        push,
        [":carol!u@h PRIVMSG #support :is anyone there", ":dave!u@h PRIVMSG #support :hello?"],
        2,
      )
      expect(after).toHaveLength(2)
      for (const id of after) expect(yield* claim(id)).toBe("fresh")
      // Stated the other way round, because "fresh" is what a routed message must NOT be: no id
      // from the second session may repeat one from the first.
      expect(after.filter((id) => before.includes(id))).toEqual([])
      expect(new Set([...before, ...after]).size).toBe(4)
    }),
  )

  test("the id is provider-issued when IRCv3 offers one, and content-addressed when it does not", () => {
    const line = IrcDriver.parseLine(":alice!u@h PRIVMSG #support :hello there")!
    // Deterministic: the same line at the same instant derives the same id, which is what makes a
    // replay dedupe rather than double-deliver.
    expect(IrcDriver.messageIDOf(line, 1_000)).toBe(IrcDriver.messageIDOf(line, 1_000))
    // ...and distinct across time, which is what makes a reconnect not collide.
    expect(IrcDriver.messageIDOf(line, 1_000)).not.toBe(IrcDriver.messageIDOf(line, 1_001))
    // Distinct across senders and across text at one instant.
    const other = IrcDriver.parseLine(":bob!u@h PRIVMSG #support :hello there")!
    const reworded = IrcDriver.parseLine(":alice!u@h PRIVMSG #support :hello there!")!
    expect(IrcDriver.messageIDOf(other, 1_000)).not.toBe(IrcDriver.messageIDOf(line, 1_000))
    expect(IrcDriver.messageIDOf(reworded, 1_000)).not.toBe(IrcDriver.messageIDOf(line, 1_000))

    // An IRCv3 tag blob used to be read as the COMMAND — the whole message vanished. Now it parses,
    // and `msgid` (a genuinely provider-issued id) wins over the derivation, at any time value.
    const tagged = IrcDriver.parseLine("@time=2026-08-31T10:00:00.000Z;msgid=abc123 :alice!u@h PRIVMSG #support :hi")
    expect(tagged?.command).toBe("PRIVMSG")
    expect(tagged?.params).toEqual(["#support", "hi"])
    expect(tagged?.tags).toEqual({ time: "2026-08-31T10:00:00.000Z", msgid: "abc123" })
    expect(IrcDriver.messageIDOf(tagged!, 1_000)).toBe("abc123")
    expect(IrcDriver.messageIDOf(tagged!, 9_999)).toBe("abc123")
    // An untagged line still has no `tags` key at all — the ordinary shape is unchanged.
    expect(line.tags).toBeUndefined()
  })
})

// ── 2. gateway commands, the flood cap and the one global hand ─────────────────────────────────

describe("messenger account safety — commands under the traffic rules", () => {
  const FLOOD = 40

  it.live("🔴 a stranger looping a command gets NOTHING, and another account keeps its voice", () =>
    Effect.gen(function* () {
      const { store, gateway, accounts } = yield* online("victim", "bystander")
      const victim = accounts[0]!
      const bystander = accounts[1]!
      // The bystander is a paired operator on a working account — somebody doing ordinary work.
      yield* store.upsertContact({
        accountID: bystander.account.id,
        senderID: "owner",
        name: "Nancy",
        trust: "operator",
        pairedAt: Date.now(),
      })
      const sentBefore = fake.state.sent.length

      // The attack: one unpaired stranger, one slash command, over and over.
      for (let i = 0; i < FLOOD; i++) {
        yield* Queue.offer(victim.queue, message("stranger-chat", { text: "/help", sender: "stranger" }))
      }
      // ...and, while it runs, one ordinary message on the OTHER account.
      const asked = Date.now()
      yield* Queue.offer(bystander.queue, message("owner-chat", { text: "/help", sender: "owner" }))

      yield* eventually(
        Effect.sync(() => fake.state.sent.slice(sentBefore)),
        (sent) => sent.some((s) => s.accountID === bystander.account.id),
        "the bystander account was answered",
      )
      const waited = Date.now() - asked

      const sent = fake.state.sent.slice(sentBefore)
      // (a) Default-deny: the stranger is answered ZERO times. Not once per message, and not even
      //     the one "you're flooding me" note — a stranger gets silence, throttle included.
      expect(sent.filter((s) => s.accountID === victim.account.id)).toEqual([])
      // (b) The one global hand was never taken: the bystander's reply is the FIRST thing sent,
      //     not the forty-first. Before the fix it queued behind the whole flood.
      expect(sent[0]?.accountID).toBe(bystander.account.id)
      // (c) And it did not merely arrive eventually — it arrived promptly. Each outbound costs
      //     PACE_STEP_MS of the single permit, so an unfixed gateway spends FLOOD × PACE_STEP_MS
      //     answering the stranger before this account is served at all. The budget is a third of
      //     that, so this cannot pass on the burst it exists to catch.
      expect(waited).toBeLessThanOrEqual((FLOOD * PACE_STEP_MS) / 3)

      yield* store.removeAccount(victim.account.id)
      yield* store.removeAccount(bystander.account.id)
      yield* gateway.reload()
    }),
  )

  it.live("a stranger looping a BAD pairing code is answered once, not once per attempt", () =>
    Effect.gen(function* () {
      const { store, gateway, accounts } = yield* online("pairing")
      const { account, queue } = accounts[0]!
      const sentBefore = fake.state.sent.length

      // `/pair` is the one command an unpaired sender may still draw an answer from — it is how a
      // stranger becomes somebody — so it is also the last path by which one can pull repeated
      // outbound out of the account. The refusal names the fix; repeating it says nothing more.
      for (let i = 0; i < FLOOD; i++) {
        yield* Queue.offer(queue, message("probe-chat", { text: "/pair not-a-real-code", sender: "stranger" }))
      }
      yield* eventually(
        Effect.sync(() => fake.state.sent.slice(sentBefore)),
        (sent) => sent.some((s) => s.text?.includes("invalid or expired") ?? false),
        "the one pairing refusal",
      )
      yield* Effect.sleep(Duration.millis(200))

      const sent = fake.state.sent.slice(sentBefore).filter((s) => s.accountID === account.id)
      expect(sent.map((s) => s.text)).toEqual([
        "That pairing code is invalid or expired. Mint a fresh one in Settings → Messengers.",
      ])
      // The stranger is still a stranger — being answered once is not being let in.
      expect(yield* store.getContact(account.id, "stranger")).toBeUndefined()

      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("🔴 an operator's own command stream is capped like any other traffic (§7.6)", () =>
    Effect.gen(function* () {
      const { store, gateway, accounts } = yield* online("cap")
      const { account, queue } = accounts[0]!
      yield* store.upsertContact({
        accountID: account.id,
        senderID: "owner",
        name: "Nancy",
        trust: "operator",
        pairedAt: Date.now(),
      })
      const sentBefore = fake.state.sent.length

      for (let i = 0; i < FLOOD; i++) {
        yield* Queue.offer(queue, message("op-chat", { text: "/help", sender: "owner" }))
      }
      // Wait for the stream to settle: the last thing the cap does is send exactly one slow-down.
      yield* eventually(
        Effect.sync(() => fake.state.sent.slice(sentBefore)),
        (sent) => sent.some((s) => s.text?.includes("faster than I can keep up") ?? false),
        "the slow-down reply",
      )
      yield* Effect.sleep(Duration.millis(200))

      const sent = fake.state.sent.slice(sentBefore).filter((s) => s.accountID === account.id)
      const helps = sent.filter((s) => s.text?.includes("faster than I can keep up") !== true)
      const warnings = sent.filter((s) => s.text?.includes("faster than I can keep up") === true)
      // The cap number itself is NOT pinned here — that would only re-type a constant. What is
      // pinned is that the cap applies at all: fewer replies went out than commands came in.
      // Before the fix this branch sat above the gate and every one of the 40 was answered.
      expect(helps.length).toBeLessThan(FLOOD)
      expect(helps.length).toBeGreaterThan(0)
      expect(warnings).toHaveLength(1)

      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )
})
