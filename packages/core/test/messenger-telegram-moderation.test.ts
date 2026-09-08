import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { ExternalDriverSource } from "@novaclaw/core/messenger/external-driver-source"
import { TelegramDriver } from "@novaclaw/core/messenger/driver/telegram"
import type { FetchLike } from "@novaclaw/core/messenger/driver/telegram"
import { TelegramUserDriver } from "@novaclaw/core/messenger/driver/telegram-user"
import type { UserClient, UserMessage } from "@novaclaw/core/messenger/driver/telegram-user"
import type { Connection, ConnectContext } from "@novaclaw/core/messenger/driver"
import { it } from "./lib/effect"

/**
 * **A capability manifest is a PROMISE, and this file is the receipt.**
 *
 * `Messenger.Capabilities` is the only advance description the layer above gets of what a transport
 * can do: the model plans against it, and the gateway refuses against the `Connection` the driver
 * actually returned. When the two disagree, the refusal is not "that feature is missing" — it is a
 * false statement about the PLATFORM, invented from a gap in our driver, that no amount of retrying
 * gets past. Both Telegram drivers shipped declaring `moderation: {delete, ban, kick, mute, pin}`
 * all true with no `moderate` in their `Connection` at all, so an agent told `ban: true` and asked
 * to remove a spammer was answered "this messenger has no moderation controls".
 *
 * The two halves are closed in opposite directions on purpose, and both are asserted here:
 *  · **telegram (bot)** — IMPLEMENTED. The Bot API has every one of the five, the driver already had
 *    the JSON seam, and moderating a supergroup is what a bot account is for.
 *  · **telegram-user (your account)** — the flags are now FALSE. Its client seam has no moderation
 *    surface, and it acts as a real person; a flag may only ever say what the code does, so it goes
 *    up in the same change that implements the act, never before it.
 *
 * ⚠️ **The implication below is DERIVED from the manifest, never from a list of drivers**, so a new
 * driver — or a new flag on an old one — is checked by the same rule without anyone remembering to
 * add it here. That is the part that closes the class; the two drivers are only its first instances.
 *
 * **A/B controls.** Drop `moderate` from `telegram.ts`'s returned Connection → the bot leg reports
 * the five unkept promises. Put `telegram-user.ts`'s `moderation` flags back to `true` → the user
 * leg reports five unkept promises. Both fail on the manifest, before any behaviour is exercised.
 */

/** Every capability flag that promises a `Connection` member, paired with the member it promises. */
const promises = (caps: Messenger.Capabilities): readonly { flag: string; member: keyof Connection }[] => [
  ...Object.entries(caps.moderation)
    .filter(([, on]) => on === true)
    .map(([act]) => ({ flag: `moderation.${act}`, member: "moderate" as const })),
  ...(caps.files.down ? [{ flag: "files.down", member: "downloadFile" as const }] : []),
  ...(caps.listChats === "full" ? [{ flag: 'listChats: "full"', member: "listChats" as const }] : []),
]

/** The flags a connection does NOT keep. `[]` is the only acceptable answer. */
const unkept = (caps: Messenger.Capabilities, connection: Connection): readonly string[] =>
  promises(caps)
    .filter((promise) => connection[promise.member] === undefined)
    .map((promise) => promise.flag)

// ── the Telegram BOT driver, against a fake Bot API ──────────────────────────────────────────────

const botApi = () => {
  const calls: { method: string; body: Record<string, unknown> }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const method = url.split("/").pop() ?? ""
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ method, body })
    if (method === "getMe") return Response.json({ ok: true, result: { id: 999, is_bot: true, username: "NovaBot" } })
    // A long-poll that holds: the scoped connection interrupts it on close.
    if (method === "getUpdates") return new Promise<Response>(() => {})
    // Telegram's own refusal (the bot lacks the right in that chat) must arrive as a legible reason.
    if (body["user_id"] === 4040) return Response.json({ ok: false, description: "not enough rights" })
    return Response.json({ ok: true, result: true })
  }
  return { fetchImpl, calls }
}

const BOT_ACCOUNT = {
  id: "msa_bot",
  driverID: "telegram",
  label: "bot",
  enabled: true,
  settings: {},
} as never as Messenger.AccountInfo

const ctxFor = (account: Messenger.AccountInfo, secret: string): ConnectContext => ({
  account,
  secret,
  cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
})

const withBot = <A, E>(
  use: (connection: Connection, calls: ReturnType<typeof botApi>["calls"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const api = botApi()
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* TelegramDriver.make(api.fetchImpl).connect(ctxFor(BOT_ACCOUNT, "TOKEN"))
        return yield* use(connection, api.calls)
      }),
    )
  })

const moderationCalls = (calls: ReturnType<typeof botApi>["calls"]) =>
  calls.filter((call) => call.method !== "getMe" && call.method !== "getUpdates")

// ── the Telegram USER driver, against a fake client ──────────────────────────────────────────────

const TG_USER_ACCOUNT = {
  id: "msa_user",
  driverID: "telegram-user",
  label: "my telegram",
  enabled: true,
  settings: { apiId: "1234567", apiHash: "a".repeat(32) },
} as never as Messenger.AccountInfo

const idleClient = (): UserClient => ({
  me: async () => ({ id: "111", name: "Me" }),
  sendCode: async () => ({ phoneCodeHash: "h", via: "app" }),
  signIn: async () => undefined,
  checkPassword: async () => undefined,
  exportSession: async () => "session",
  pull: () => new Promise<readonly UserMessage[]>(() => {}),
  dialogs: async () => [],
  history: async () => [],
  sendText: async () => ({ messageID: "1" }),
  sendFile: async () => ({ messageID: "1" }),
  downloadFile: async () => new Uint8Array(),
  close: async () => undefined,
})

// ── the whole registry: the two published copies of a manifest may not drift ─────────────────────

const registry = MessengerDrivers.layer.pipe(
  Layer.provide(
    Layer.succeed(ExternalDriverSource.Service, ExternalDriverSource.Service.of({ drivers: () => Effect.succeed([]) })),
  ),
)

describe("a driver's capability manifest and its Connection", () => {
  it.live("🔴 telegram (bot): every advertised moderation act is IMPLEMENTED and reaches the Bot API", () =>
    withBot((connection, calls) =>
      Effect.gen(function* () {
        // The manifest first: no advertised flag may be without its member.
        expect(unkept(TelegramDriver.make(botApi().fetchImpl).capabilities(BOT_ACCOUNT), connection)).toEqual([])
        const moderate = connection.moderate
        if (moderate === undefined) throw new Error("telegram bot connection has no moderate")

        yield* moderate("-100777", { act: "delete", messageID: "42" })
        yield* moderate("-100777", { act: "pin", messageID: "42" })
        yield* moderate("-100777", { act: "ban", userID: "555" })
        yield* moderate("-100777", { act: "kick", userID: "556" })
        yield* moderate("-100777", { act: "mute", userID: "557", seconds: 120 })

        const issued = moderationCalls(calls)
        expect(issued.map((call) => call.method)).toEqual([
          "deleteMessage",
          "pinChatMessage",
          "banChatMember",
          // A kick is a ban lifted at once — Telegram has no kick verb, and BOTH halves must go out
          // or the "kick" is a permanent ban wearing the wrong name.
          "banChatMember",
          "unbanChatMember",
          "restrictChatMember",
        ])
        expect(issued[0]?.body).toMatchObject({ chat_id: -100777, message_id: 42 })
        expect(issued[4]?.body).toMatchObject({ user_id: 556, only_if_banned: true })
        // A plain ban carries no until_date — a bounded one would be a ban that quietly expires.
        expect(issued[2]?.body["until_date"]).toBeUndefined()
        expect(Number(issued[5]?.body["until_date"])).toBeGreaterThan(Math.floor(Date.now() / 1000))
      }),
    ),
  )

  it.live("a modifier Telegram cannot honour is REFUSED, never quietly widened", () =>
    withBot((connection, calls) =>
      Effect.gen(function* () {
        const moderate = connection.moderate
        if (moderate === undefined) throw new Error("telegram bot connection has no moderate")

        // `purgeSeconds` asks for the last N seconds of a member's posts. Telegram's only purge
        // deletes EVERYTHING they ever wrote there, so doing it anyway would over-delete silently.
        // ⚠️ `Effect.flip`, not `Effect.exit`: it fails the test if the op SUCCEEDS, so a driver that
        // quietly did the wider thing could not pass by returning void.
        const purge = yield* Effect.flip(moderate("-100777", { act: "ban", userID: "555", purgeSeconds: 3600 }))
        expect(purge.reason).toContain("delete ALL")

        // Out of Telegram's 1..366-day window `until_date` silently means FOREVER.
        const tooLong = yield* Effect.flip(moderate("-100777", { act: "ban", userID: "555", durationDays: 1000 }))
        expect(tooLong.reason).toContain("permanent")

        // Neither refusal may have touched the wire.
        expect(moderationCalls(calls)).toEqual([])

        // In range it goes out, bounded.
        yield* moderate("-100777", { act: "ban", userID: "555", durationDays: 7 })
        const banned = moderationCalls(calls)[0]
        expect(banned?.method).toBe("banChatMember")
        expect(Number(banned?.body["until_date"])).toBeGreaterThan(Math.floor(Date.now() / 1000) + 6 * 86_400)

        // An act the manifest does NOT advertise refuses, and names OUR gap rather than inventing a
        // platform limit (Telegram can close a group; this driver chooses not to).
        const locked = yield* Effect.flip(moderate("-100777", { act: "lock" }))
        expect(locked.reason).toContain("This driver doesn't lock")

        // And Telegram's own refusal arrives with Telegram's words, not ours.
        const refused = yield* Effect.flip(moderate("-100777", { act: "ban", userID: "4040" }))
        expect(refused.reason).toContain("not enough rights")
      }),
    ),
  )

  it.live("🔴 telegram-user (your account): the manifest claims nothing its Connection cannot do", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = TelegramUserDriver.make(async () => idleClient())
        const connection = yield* driver.connect(ctxFor(TG_USER_ACCOUNT, "session-blob"))
        const caps = driver.capabilities(TG_USER_ACCOUNT)
        expect(unkept(caps, connection)).toEqual([])
        // Stated positively, so the direction of the fix is on the record: this driver does not
        // moderate, and now says so.
        expect(Object.values(caps.moderation).some((flag) => flag === true)).toBe(false)
        expect(connection.moderate).toBeUndefined()
        // The capabilities it DOES claim are still kept — the check above is not vacuous.
        expect(caps.listChats).toBe("full")
        expect(connection.listChats).toBeDefined()
        expect(connection.downloadFile).toBeDefined()
      }),
    ),
  )

  it.effect("every registered driver publishes ONE manifest: meta.capabilities === capabilities()", () =>
    Effect.gen(function* () {
      const drivers = yield* MessengerDrivers.Service
      const all = drivers.all()
      expect(all.length).toBeGreaterThan(4)
      for (const driver of all)
        expect({ id: driver.id, caps: driver.capabilities(TG_USER_ACCOUNT) }).toEqual({
          id: driver.id,
          caps: driver.meta.capabilities,
        })
    }).pipe(Effect.provide(registry)),
  )
})
