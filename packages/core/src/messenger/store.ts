export * as MessengerStore from "./store"

import { and, eq } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import {
  MessengerAccountTable,
  MessengerBindingTable,
  MessengerChatTable,
  MessengerContactTable,
  MessengerCursorTable,
} from "./sql"

// The Messenger module's persistence (notes/messenger-plan.md §3.1): accounts, the seen-chat
// cache, paired contacts, bindings, and durable per-account cursors. Instance-global (accounts
// span locations; sessions from any location can bind). LIVE reads only — nothing here rides
// the boot-frozen Config snapshot, so the agent tool and the gateway always see current state.

export class ChatAlreadyBoundError extends Schema.TaggedErrorClass<ChatAlreadyBoundError>()(
  "MessengerStore.ChatAlreadyBound",
  { sessionID: Schema.String },
) {}

export interface ContactInfo {
  readonly accountID: Messenger.AccountID
  readonly senderID: string
  readonly name: string
  readonly trust: Messenger.ContactTrust
  readonly pairedAt: number | undefined
}

export interface AccountInput {
  readonly driverID: string
  readonly label: string
  readonly enabled: boolean
  readonly credentialID?: string
  readonly settings: Record<string, string>
}

export interface AccountPatch {
  readonly label?: string
  readonly enabled?: boolean
  readonly credentialID?: string | null
  readonly settings?: Record<string, string>
}

export interface Interface {
  readonly listAccounts: () => Effect.Effect<Messenger.AccountInfo[]>
  readonly getAccount: (id: Messenger.AccountID) => Effect.Effect<Messenger.AccountInfo | undefined>
  readonly createAccount: (input: AccountInput) => Effect.Effect<Messenger.AccountInfo>
  readonly updateAccount: (id: Messenger.AccountID, patch: AccountPatch) => Effect.Effect<void>
  /** Removes the account AND its chats, contacts, bindings, and cursor (edge #9's substrate). */
  readonly removeAccount: (id: Messenger.AccountID) => Effect.Effect<void>

  /** Upsert into the seen-chat cache (kind/title refresh, last_seen advances). */
  readonly seenChat: (input: {
    readonly accountID: Messenger.AccountID
    readonly chatID: string
    readonly kind: Messenger.ChatKind
    readonly title: string
    readonly at: number
  }) => Effect.Effect<void>
  readonly listChats: (accountID: Messenger.AccountID) => Effect.Effect<Messenger.ChatInfo[]>
  /** True if we've ever seen this chat (an inbound message put it in the cache) — the cold-start
   *  test for the traffic-rules governor: a chat we've never heard from is a NEW conversation. */
  readonly hasChat: (accountID: Messenger.AccountID, chatID: string) => Effect.Effect<boolean>

  readonly upsertContact: (contact: ContactInfo) => Effect.Effect<void>
  readonly getContact: (accountID: Messenger.AccountID, senderID: string) => Effect.Effect<ContactInfo | undefined>
  readonly listContacts: (accountID: Messenger.AccountID) => Effect.Effect<ContactInfo[]>
  readonly removeContact: (accountID: Messenger.AccountID, senderID: string) => Effect.Effect<void>

  readonly createBinding: (input: {
    readonly accountID: Messenger.AccountID
    readonly chatID: string
    readonly sessionID: string
    readonly trust: Messenger.Trust
  }) => Effect.Effect<Messenger.BindingInfo, ChatAlreadyBoundError>
  readonly bindingForChat: (
    accountID: Messenger.AccountID,
    chatID: string,
  ) => Effect.Effect<Messenger.BindingInfo | undefined>
  /**
   * Every binding held by ONE session. **Fails CLOSED to `[]` and names the fault in a log** — it
   * never dies, and `E = never` here is now a fact rather than a claim.
   *
   * Why this one read is special: it is the only store read consumed by a GUARD. Four call sites
   * take it, and all four already wrap it in `Effect.orElseSucceed(() => [])` because
   * "lookup failed" is documented as "no binding here":
   *   · `host-exec.ts` `chainHasHostileBinding` — the messenger-trust half of the bash/Strict
   *     confinement decision (its `ChainLookup` types the lookup as `Effect<…, unknown>`, i.e. it
   *     EXPECTS failure);
   *   · `messenger/gateway.ts`'s outbound relay — an instance-global fiber;
   *   · the `messenger` tool's `status` and `disconnect` ops.
   * `orElseSucceed` does not catch a DIE. So while this ended in `Effect.orDie`, every one of those
   * four recoveries was unreachable code: a sqlite fault unwound the fiber instead of failing
   * closed — killing the turn, and in the relay's case killing the ONE fiber that delivers replies
   * to every bound chat instance-wide. The test that "proved" the recovery used `Effect.fail`,
   * which is caught, so it stayed green over a path production could not take.
   *
   * ⚠️ `[]` is the DOCUMENTED "no binding here", and it is fail-closed for three of the four
   * consumers (no relay, no binding shown, nothing to disconnect) — but for the hostile-chain walk
   * it is the PERMISSIVE answer: an unreadable database reads as "no untrusted chat drives this
   * turn", so bash runs raw rather than confined. Fixing that honestly means the walk distinguishing
   * "unknown" from "no binding", which is a change to `host-exec.ts` + `session/runner/llm.ts`, not
   * to this signature. Filed, not silently absorbed: the log line below is what makes it visible.
   */
  readonly bindingsForSession: (sessionID: string) => Effect.Effect<Messenger.BindingInfo[]>
  readonly bindingsForAccount: (accountID: Messenger.AccountID) => Effect.Effect<Messenger.BindingInfo[]>
  readonly listBindings: () => Effect.Effect<Messenger.BindingInfo[]>
  readonly removeBinding: (id: Messenger.BindingID) => Effect.Effect<void>
  readonly setBindingStatus: (id: Messenger.BindingID, status: Messenger.BindingStatus) => Effect.Effect<void>

  readonly getCursor: (accountID: Messenger.AccountID) => Effect.Effect<unknown>
  readonly setCursor: (accountID: Messenger.AccountID, value: unknown) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/MessengerStore") {}

type AccountRow = typeof MessengerAccountTable.$inferSelect
type ChatRow = typeof MessengerChatTable.$inferSelect
type BindingRow = typeof MessengerBindingTable.$inferSelect
type ContactRow = typeof MessengerContactTable.$inferSelect

const accountFromRow = (row: AccountRow): Messenger.AccountInfo =>
  new Messenger.AccountInfo({
    id: row.id,
    driverID: row.driver_id,
    label: row.label,
    enabled: row.enabled,
    ...(row.credential_id === null ? {} : { credentialID: row.credential_id as Messenger.AccountInfo["credentialID"] }),
    settings: (row.settings ?? {}) as Record<string, string>,
  })

const chatFromRow = (row: ChatRow): Messenger.ChatInfo =>
  new Messenger.ChatInfo({
    accountID: row.account_id,
    chatID: row.chat_id,
    kind: row.kind,
    title: row.title,
    lastSeen: row.last_seen,
  })

const bindingFromRow = (row: BindingRow): Messenger.BindingInfo =>
  new Messenger.BindingInfo({
    id: row.id,
    accountID: row.account_id,
    chatID: row.chat_id,
    sessionID: row.session_id as Messenger.BindingInfo["sessionID"],
    trust: row.trust,
    status: row.status,
  })

/**
 * The salvage idiom for a read whose caller is a GUARD (`settings-config-seed.ts` is the house
 * template: keep what is readable, NAME what was lost, never fault the caller). Returns `fallback`
 * on any database fault and logs the cause — a subsystem that cannot answer says so instead of
 * either lying silently or taking the fiber down with it (standing decision 3).
 *
 * Interrupts are re-raised untouched: interruption is not a fault, and swallowing it would make a
 * cancelled turn or a gateway teardown look like an empty result.
 */
const failClosed = <A, E>(query: Effect.Effect<A, E>, fallback: A, what: string): Effect.Effect<A> =>
  query.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.logWarning(
            `MessengerStore.${what}: the messenger database could not be read — failing closed`,
            { cause: Cause.pretty(cause) },
          ).pipe(Effect.as(fallback)),
    ),
  )

const contactFromRow = (row: ContactRow): ContactInfo => ({
  accountID: row.account_id,
  senderID: row.sender_id,
  name: row.name,
  trust: row.trust,
  pairedAt: row.paired_at ?? undefined,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      listAccounts: Effect.fn("MessengerStore.listAccounts")(function* () {
        const rows = yield* db.select().from(MessengerAccountTable).all().pipe(Effect.orDie)
        return rows.map(accountFromRow)
      }),
      getAccount: Effect.fn("MessengerStore.getAccount")(function* (id) {
        const row = yield* db.select().from(MessengerAccountTable).where(eq(MessengerAccountTable.id, id)).get().pipe(Effect.orDie)
        return row === undefined ? undefined : accountFromRow(row)
      }),
      createAccount: Effect.fn("MessengerStore.createAccount")(function* (input) {
        const id = Messenger.AccountID.create()
        yield* db
          .insert(MessengerAccountTable)
          .values({
            id,
            driver_id: input.driverID,
            label: input.label,
            enabled: input.enabled,
            credential_id: input.credentialID ?? null,
            settings: input.settings,
          })
          .run()
          .pipe(Effect.orDie)
        return new Messenger.AccountInfo({
          id,
          driverID: input.driverID,
          label: input.label,
          enabled: input.enabled,
          ...(input.credentialID === undefined
            ? {}
            : { credentialID: input.credentialID as Messenger.AccountInfo["credentialID"] }),
          settings: input.settings,
        })
      }),
      updateAccount: Effect.fn("MessengerStore.updateAccount")(function* (id, patch) {
        yield* db
          .update(MessengerAccountTable)
          .set({
            ...(patch.label === undefined ? {} : { label: patch.label }),
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            ...(patch.credentialID === undefined ? {} : { credential_id: patch.credentialID }),
            ...(patch.settings === undefined ? {} : { settings: patch.settings }),
          })
          .where(eq(MessengerAccountTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      removeAccount: Effect.fn("MessengerStore.removeAccount")(function* (id) {
        yield* db.delete(MessengerBindingTable).where(eq(MessengerBindingTable.account_id, id)).run().pipe(Effect.orDie)
        yield* db.delete(MessengerContactTable).where(eq(MessengerContactTable.account_id, id)).run().pipe(Effect.orDie)
        yield* db.delete(MessengerChatTable).where(eq(MessengerChatTable.account_id, id)).run().pipe(Effect.orDie)
        yield* db.delete(MessengerCursorTable).where(eq(MessengerCursorTable.account_id, id)).run().pipe(Effect.orDie)
        yield* db.delete(MessengerAccountTable).where(eq(MessengerAccountTable.id, id)).run().pipe(Effect.orDie)
      }),

      seenChat: Effect.fn("MessengerStore.seenChat")(function* (input) {
        yield* db
          .insert(MessengerChatTable)
          .values({
            account_id: input.accountID,
            chat_id: input.chatID,
            kind: input.kind,
            title: input.title,
            last_seen: input.at,
          })
          .onConflictDoUpdate({
            target: [MessengerChatTable.account_id, MessengerChatTable.chat_id],
            set: { kind: input.kind, title: input.title, last_seen: input.at },
          })
          .run()
          .pipe(Effect.orDie)
      }),
      listChats: Effect.fn("MessengerStore.listChats")(function* (accountID) {
        const rows = yield* db
          .select()
          .from(MessengerChatTable)
          .where(eq(MessengerChatTable.account_id, accountID))
          .all()
          .pipe(Effect.orDie)
        return rows.map(chatFromRow).sort((a, b) => b.lastSeen - a.lastSeen)
      }),
      hasChat: Effect.fn("MessengerStore.hasChat")(function* (accountID, chatID) {
        const row = yield* db
          .select()
          .from(MessengerChatTable)
          .where(and(eq(MessengerChatTable.account_id, accountID), eq(MessengerChatTable.chat_id, chatID)))
          .get()
          .pipe(Effect.orDie)
        return row !== undefined
      }),

      upsertContact: Effect.fn("MessengerStore.upsertContact")(function* (contact) {
        yield* db
          .insert(MessengerContactTable)
          .values({
            account_id: contact.accountID,
            sender_id: contact.senderID,
            name: contact.name,
            trust: contact.trust,
            paired_at: contact.pairedAt ?? null,
          })
          .onConflictDoUpdate({
            target: [MessengerContactTable.account_id, MessengerContactTable.sender_id],
            set: { name: contact.name, trust: contact.trust, paired_at: contact.pairedAt ?? null },
          })
          .run()
          .pipe(Effect.orDie)
      }),
      getContact: Effect.fn("MessengerStore.getContact")(function* (accountID, senderID) {
        const row = yield* db
          .select()
          .from(MessengerContactTable)
          .where(and(eq(MessengerContactTable.account_id, accountID), eq(MessengerContactTable.sender_id, senderID)))
          .get()
          .pipe(Effect.orDie)
        return row === undefined ? undefined : contactFromRow(row)
      }),
      listContacts: Effect.fn("MessengerStore.listContacts")(function* (accountID) {
        const rows = yield* db
          .select()
          .from(MessengerContactTable)
          .where(eq(MessengerContactTable.account_id, accountID))
          .all()
          .pipe(Effect.orDie)
        return rows.map(contactFromRow)
      }),
      removeContact: Effect.fn("MessengerStore.removeContact")(function* (accountID, senderID) {
        yield* db
          .delete(MessengerContactTable)
          .where(and(eq(MessengerContactTable.account_id, accountID), eq(MessengerContactTable.sender_id, senderID)))
          .run()
          .pipe(Effect.orDie)
      }),

      createBinding: Effect.fn("MessengerStore.createBinding")(function* (input) {
        // Select-then-insert: the unique index is the real guard; this pre-check turns the
        // constraint violation into a typed, actionable error naming the holding session.
        const existing = yield* db
          .select()
          .from(MessengerBindingTable)
          .where(
            and(eq(MessengerBindingTable.account_id, input.accountID), eq(MessengerBindingTable.chat_id, input.chatID)),
          )
          .get()
          .pipe(Effect.orDie)
        if (existing !== undefined) return yield* Effect.fail(new ChatAlreadyBoundError({ sessionID: existing.session_id }))
        const id = Messenger.BindingID.create()
        yield* db
          .insert(MessengerBindingTable)
          .values({
            id,
            account_id: input.accountID,
            chat_id: input.chatID,
            session_id: input.sessionID,
            trust: input.trust,
            status: "active",
          })
          .run()
          .pipe(Effect.orDie)
        return bindingFromRow({
          id,
          account_id: input.accountID,
          chat_id: input.chatID,
          session_id: input.sessionID,
          trust: input.trust,
          status: "active",
          time_created: 0,
          time_updated: 0,
        })
      }),
      bindingForChat: Effect.fn("MessengerStore.bindingForChat")(function* (accountID, chatID) {
        const row = yield* db
          .select()
          .from(MessengerBindingTable)
          .where(and(eq(MessengerBindingTable.account_id, accountID), eq(MessengerBindingTable.chat_id, chatID)))
          .get()
          .pipe(Effect.orDie)
        return row === undefined ? undefined : bindingFromRow(row)
      }),
      // ⚠️ NOT `Effect.orDie` — see the interface note. Every consumer of this read is a guard that
      // already recovers with `orElseSucceed(() => [])`, and `orElseSucceed` cannot catch a die, so
      // dying here made all four recoveries dead code. The recovery lives at the source instead.
      bindingsForSession: Effect.fn("MessengerStore.bindingsForSession")(function* (sessionID) {
        const rows = yield* failClosed(
          db.select().from(MessengerBindingTable).where(eq(MessengerBindingTable.session_id, sessionID)).all(),
          [] as BindingRow[],
          `bindingsForSession(${sessionID})`,
        )
        return rows.map(bindingFromRow)
      }),
      bindingsForAccount: Effect.fn("MessengerStore.bindingsForAccount")(function* (accountID) {
        const rows = yield* db
          .select()
          .from(MessengerBindingTable)
          .where(eq(MessengerBindingTable.account_id, accountID))
          .all()
          .pipe(Effect.orDie)
        return rows.map(bindingFromRow)
      }),
      listBindings: Effect.fn("MessengerStore.listBindings")(function* () {
        const rows = yield* db.select().from(MessengerBindingTable).all().pipe(Effect.orDie)
        return rows.map(bindingFromRow)
      }),
      removeBinding: Effect.fn("MessengerStore.removeBinding")(function* (id) {
        yield* db.delete(MessengerBindingTable).where(eq(MessengerBindingTable.id, id)).run().pipe(Effect.orDie)
      }),
      setBindingStatus: Effect.fn("MessengerStore.setBindingStatus")(function* (id, status) {
        yield* db
          .update(MessengerBindingTable)
          .set({ status })
          .where(eq(MessengerBindingTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),

      getCursor: Effect.fn("MessengerStore.getCursor")(function* (accountID) {
        const row = yield* db
          .select()
          .from(MessengerCursorTable)
          .where(eq(MessengerCursorTable.account_id, accountID))
          .get()
          .pipe(Effect.orDie)
        return row?.cursor
      }),
      setCursor: Effect.fn("MessengerStore.setCursor")(function* (accountID, value) {
        yield* db
          .insert(MessengerCursorTable)
          .values({ account_id: accountID, cursor: value })
          .onConflictDoUpdate({ target: MessengerCursorTable.account_id, set: { cursor: value } })
          .run()
          .pipe(Effect.orDie)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
