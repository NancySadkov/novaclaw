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

/**
 * The messenger database could not be read, so this store has NO ANSWER to give — not an empty one.
 *
 * ⚠️ A TYPED failure on purpose, and the third shape this read has had. It was `Effect.orDie` (a
 * defect: it unwound the caller's fiber, and the four `orElseSucceed(() => [])` recoveries written
 * for it were unreachable code). Wave 1 made it succeed with `[]` and log — which fixed the fiber
 * kill but handed `host-exec.ts`'s containment walk the most PERMISSIVE possible answer to a
 * question the database had just refused to answer. A typed failure is the only one of the three
 * that lets each consumer decide: `orElseSucceed(() => [])` still catches it (a die never was), so
 * the relay and the `messenger` tool keep their documented fail-closed empty, while the guard can
 * finally tell "no untrusted chat" from "we could not look".
 *
 * It is also the mechanical half: a NEW consumer cannot silently inherit a fail-closed empty it
 * never thought about, because the error channel makes the compiler ask.
 */
export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("MessengerStore.Unavailable", {
  /** Which read faulted, e.g. `bindingsForSession(ses_abc)` — the same text the log line names. */
  read: Schema.String,
  /** The pretty-printed sqlite cause. NOT named `cause`: that is an own property of `Error`, and a
   *  schema field would shadow it and confuse `Cause.pretty` on anything wrapping this. */
  detail: Schema.String,
}) {}

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
   * Every binding held by ONE session. **Names the fault in a log and then FAILS TYPED** — it never
   * dies, and it never answers `[]` for a read it could not perform.
   *
   * Why this one read is special: it is the only store read consumed by a GUARD. Four call sites
   * take it, and three of them recover with `Effect.orElseSucceed(() => [])`, for which an empty
   * result is genuinely fail-closed:
   *   · `messenger/gateway.ts`'s outbound relay — an instance-global fiber; no bindings, no relay;
   *   · the `messenger` tool's `status` and `disconnect` ops — nothing shown, nothing to disconnect.
   * The fourth is different in kind: `host-exec.ts` `chainHasHostileBinding`, the messenger-trust
   * half of the bash/Strict confinement decision. There, `[]` is the **permissive** answer — "no
   * untrusted chat drives this turn" — so an unreadable database used to buy raw host execution.
   *
   * ⚠️ Three shapes, and the reasoning for the third. `Effect.orDie` made all four recoveries
   * unreachable (a defect unwinds the fiber; `orElseSucceed` catches a failure, not a die), so a
   * sqlite fault killed the turn — and in the relay's case the ONE fiber delivering replies to every
   * bound chat instance-wide. Wave 1 replaced it with succeed-`[]`-and-log, which fixed that and
   * left the guard deciding containment on data it did not have. This — log, then fail typed with
   * `UnavailableError` — is the shape that serves all four: the three keep their `orElseSucceed`
   * (unchanged, still compiling, still fail-closed), and the guard finally distinguishes *unknown*
   * from *no binding*. `host-exec.ts` maps any failure here to `Hostility "unknown"`, which takes
   * the unattended arm: confined where a sandbox backend exists, denied where none does.
   *
   * ⚠️ Do NOT "simplify" this back to `Effect<…[]>`. The empty array and the unreadable database are
   * different facts, and a signature that cannot tell them apart is how a containment decision came
   * to be made on missing data in the first place.
   */
  readonly bindingsForSession: (sessionID: string) => Effect.Effect<Messenger.BindingInfo[], UnavailableError>
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
 * The idiom for a read whose caller is a GUARD: NAME what was lost, never take the caller's fiber
 * down with it, and never invent an answer on its behalf. Any database fault is logged (a subsystem
 * that cannot answer says so — ruling 2) and then converted to a typed `UnavailableError`, so the
 * *consumer* chooses what an unreadable database means for it. Three consumers say "an empty
 * result"; the containment guard says "unknown", and those are not the same decision.
 *
 * ⚠️ It deliberately does NOT take a fallback any more. A fallback parameter here is the shape that
 * let one call site's fail-closed empty become another's permissive default, invisibly, because the
 * signature could not tell the two apart.
 *
 * Interrupts are re-raised untouched: interruption is not a fault, and swallowing it would make a
 * cancelled turn or a gateway teardown look like a broken database.
 */
const nameTheFault = <A, E>(query: Effect.Effect<A, E>, what: string): Effect.Effect<A, UnavailableError> =>
  query.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.logWarning(`MessengerStore.${what}: the messenger database could not be read`, {
            cause: Cause.pretty(cause),
          }).pipe(Effect.flatMap(() => Effect.fail(new UnavailableError({ read: what, detail: Cause.pretty(cause) })))),
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
      // ⚠️ NOT `Effect.orDie` (a die is uncatchable by the consumers' `orElseSucceed`, so it killed
      // the turn) and NOT a silent `[]` (that is the PERMISSIVE answer for the containment guard —
      // see the interface note). Logged and failed typed: each consumer decides for itself.
      bindingsForSession: Effect.fn("MessengerStore.bindingsForSession")(function* (sessionID) {
        const rows = yield* nameTheFault(
          db.select().from(MessengerBindingTable).where(eq(MessengerBindingTable.session_id, sessionID)).all(),
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
