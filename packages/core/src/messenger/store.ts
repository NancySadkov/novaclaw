export * as MessengerStore from "./store"

import { and, eq, sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Log } from "@novaclaw/schema/log"
import {
  MessengerAccountTable,
  MessengerBindingTable,
  MessengerChatTable,
  MessengerContactTable,
  MessengerCursorTable,
  MessengerInitiationTable,
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
 * ⚠️ A TYPED failure on purpose, and the third shape these reads have had. They were `Effect.orDie`
 * (a defect: it unwound the caller's fiber, and the `orElseSucceed(() => [])` recoveries written
 * for them were unreachable code). Wave 1 made `bindingsForSession` succeed with `[]` and log —
 * which fixed the fiber kill but handed `host-exec.ts`'s containment walk the most PERMISSIVE
 * possible answer to a question the database had just refused to answer. A typed failure is the
 * only one of the three that lets each consumer decide: `orElseSucceed(…)` still catches it (a die
 * never was), so a consumer that genuinely wants an empty keeps it in one line, while a consumer
 * whose empty would be a LIE can finally tell "nothing there" from "we could not look".
 *
 * It is also the mechanical half: a NEW consumer cannot silently inherit a fail-closed empty it
 * never thought about, because the error channel makes the compiler ask.
 *
 * **Four reads carry it** — `bindingsForSession` (2026-07-28, the containment guard) plus
 * `listAccounts`, `hasChat` and `bindingForChat` (the same day, the same defect class: each was
 * `orDie` under an `orElseSucceed` whose fallback made the product state something false — "No
 * messenger accounts are set up", "This chat has never messaged us", "This chat isn't driving any
 * session"). Every other read here is still `orDie`, and that is a real gap rather than a
 * distinction: they are simply not yet consumed anywhere that an invented answer would lie.
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
  /**
   * Every configured account. **Fails typed rather than answering `[]`** — an empty list is the
   * product's own "no messenger accounts are set up, add one in Settings", which is a claim about
   * the USER'S SETUP and is false when the truth is that the table could not be read. It is also
   * the destructive answer for `gateway.ts`'s `reconcile`, which stops every connection whose
   * account is missing from the list: one faulted read would disconnect every live messenger on
   * the instance. See `UnavailableError`.
   */
  readonly listAccounts: () => Effect.Effect<Messenger.AccountInfo[], UnavailableError>
  readonly getAccount: (id: Messenger.AccountID) => Effect.Effect<Messenger.AccountInfo | undefined>
  readonly createAccount: (input: AccountInput) => Effect.Effect<Messenger.AccountInfo>
  readonly updateAccount: (id: Messenger.AccountID, patch: AccountPatch) => Effect.Effect<void>
  /** Removes the account AND its chats, contacts, bindings, and cursor (edge #9's substrate). */
  readonly removeAccount: (id: Messenger.AccountID) => Effect.Effect<void>

  /** Upsert into the seen-chat cache (kind/title/proposed-access refresh, last_seen advances).
   *  ⚠️ It CANNOT write the user's `declared` access — see the implementation's note. */
  readonly seenChat: (input: {
    readonly accountID: Messenger.AccountID
    readonly chatID: string
    readonly kind: Messenger.ChatKind
    readonly title: string
    readonly at: number
    /** The DRIVER's proposal (ruling 7). Absent = no evidence, stored as `unknown`. */
    readonly proposedAccess?: Messenger.SourceAccess
  }) => Effect.Effect<void>
  readonly listChats: (accountID: Messenger.AccountID) => Effect.Effect<Messenger.ChatInfo[]>
  /**
   * One cached chat, label included — the read the gateway's ruling-7 gate consults before it lets
   * anything be read AS A SOURCE. **Fails typed rather than answering `undefined`**: `undefined`
   * means "this instance has never seen that chat", and a gate that cannot tell that from "the
   * database did not answer" would refuse (or worse, explain) under a reason it invented.
   */
  readonly getChat: (
    accountID: Messenger.AccountID,
    chatID: string,
  ) => Effect.Effect<Messenger.ChatInfo | undefined, UnavailableError>
  /**
   * Record the USER'S OWN access declaration for one chat — the only writer of `declared_access`
   * that exists, by design (ruling 7). `undefined` clears it back to "nobody has chosen".
   *
   * ⚠️ **Nothing model-facing may reach this.** A declaration is the user's word; if an agent could
   * set it, a prompt-injected message in a chat could relabel that chat public and have itself
   * quoted into a report. The `messenger` tool therefore has no op for it, and the surface that
   * should is the Settings chat picker (todo/messenger.md → P3).
   *
   * Answers `false` when the chat is not in the seen-cache — never creates the row.
   */
  readonly declareChatAccess: (input: {
    readonly accountID: Messenger.AccountID
    readonly chatID: string
    readonly access: Messenger.SourceAccess | undefined
  }) => Effect.Effect<boolean>
  /**
   * True if we've ever seen this chat (an inbound message put it in the cache) — the cold-start
   * test for the traffic-rules governor: a chat we've never heard from is a NEW conversation.
   *
   * **Fails typed rather than answering `false`.** `false` here means "nobody in this chat has ever
   * written to us", which the gateway turns into a refusal that says exactly that — a statement
   * about the CORRESPONDENT, made from a database read that never happened. See `UnavailableError`.
   */
  readonly hasChat: (accountID: Messenger.AccountID, chatID: string) => Effect.Effect<boolean, UnavailableError>

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
  /**
   * The binding a chat drives, if any. **Fails typed rather than answering `undefined`** — the
   * `undefined` is the same lying-empty shape `[]` was for `bindingsForSession`, and it is read at
   * four seams that each turn it into a different false statement: `/status` says "This chat isn't
   * driving any session", `/use` rebinds over a binding it never saw, the inbound router answers
   * "No session is linked here yet" (and, in a self-chat, MINTS a second console session on a read
   * that failed), and `send` folds it into the cold-start refusal. See `UnavailableError`.
   */
  readonly bindingForChat: (
    accountID: Messenger.AccountID,
    chatID: string,
  ) => Effect.Effect<Messenger.BindingInfo | undefined, UnavailableError>
  /**
   * Every binding held by ONE session. **Names the fault in a log and then FAILS TYPED** — it never
   * dies, and it never answers `[]` for a read it could not perform.
   *
   * Why this one read is special: it is the only store read consumed by a GUARD. Four call sites
   * take it. ⚠️ **Only ONE of them still recovers to an empty**, and the list below has been
   * corrected (2026-07-28) because the original three were not alike:
   *   · `messenger/gateway.ts`'s outbound relay KEEPS `Effect.orElseSucceed(() => [])` — no
   *     bindings, no relay, and there is nobody to tell (it is an instance-global fiber with no
   *     chat of its own), so an empty is genuinely fail-closed there;
   *   · the `messenger` tool's `status` and `disconnect` ops NO LONGER take the empty. Their empty
   *     rendered as "This chat has no remote binding" / "This session has no messenger binding to
   *     disconnect" — statements about the session, made from a read that failed. They now name the
   *     fault instead, which is the same correction this read's own signature exists to enable.
   * The fourth is different in kind: `host-exec.ts` `chainHasHostileBinding`, the messenger-trust
   * half of the bash/Strict confinement decision. There, `[]` is the **permissive** answer — "no
   * untrusted chat drives this turn" — so an unreadable database used to buy raw host execution.
   *
   * ⚠️ Three shapes, and the reasoning for the third. `Effect.orDie` made all four recoveries
   * unreachable (a defect unwinds the fiber; `orElseSucceed` catches a failure, not a die), so a
   * sqlite fault killed the turn — and in the relay's case the ONE fiber delivering replies to every
   * bound chat instance-wide. Wave 1 replaced it with succeed-`[]`-and-log, which fixed that and
   * left the guard deciding containment on data it did not have. This — log, then fail typed with
   * `UnavailableError` — is the shape that serves all four: each consumer spends one line saying
   * what an unreadable database means for IT, and the guard finally distinguishes *unknown* from
   * *no binding*. `host-exec.ts` maps any failure here to `Hostility "unknown"`, which takes
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

  /**
   * Spend one slot from the DURABLE daily cold-start budget, or answer that today's is gone.
   *
   * ⚠️ **Test-and-charge is ONE statement, and that is the whole point of it living here.** The
   * in-memory bucket this replaces read and wrote in the same synchronous tick, so no read-then-write
   * window existed; a durable counter introduces one, and two concurrent initiations that both read
   * 19 would both send — the day exceeds the cap and the account it protects is the owner's real one.
   * So the check, the day rollover and the increment are a single SQLite upsert whose `DO UPDATE …
   * WHERE` *is* the cap test: SQLite skips a `DO UPDATE` whose `WHERE` is false and returns no row,
   * which is exactly `exhausted`. No transaction to forget, and it holds across PROCESSES too (two
   * instances on one database file serialize on the write lock) — which an in-process mutex would not.
   *
   * ⚠️ **Fails typed rather than answering `exhausted` or `charged`** — the ruling-2 discipline this
   * module already applies to `hasChat` and `bindingForChat`. Neither invented answer is acceptable:
   * `charged` on an unreadable database is an uncounted cold DM to a stranger (the ban risk 9(b)
   * exists to bound), and `exhausted` states "you have used today's twenty" — a claim about the day's
   * traffic made from a write that never happened. The caller must decide, and `gateway.send` decides
   * `unavailable`: we could not find out whether we were allowed to, so nothing goes out.
   *
   * `at` is the caller's clock reading (never read here — the gateway is on `Clock.currentTimeMillis`
   * so tests can cross midnight on the TestClock), and `cap` is the caller's policy number, so the
   * limit stays declared in exactly one place (`MessengerGateway.DAILY_NEW_CONVERSATION_CAP`).
   */
  readonly chargeInitiation: (input: {
    readonly at: number
    readonly cap: number
  }) => Effect.Effect<InitiationCharge, UnavailableError>
}

/**
 * The answer to *may we start one more conversation today?* — asked and answered by SPENDING it.
 *
 * A `kind` discriminant rather than a boolean, for the reason `SendOutcome` gives at length: a
 * two-state answer invites `if (!charge.ok)`, and the third state this question really has (the
 * database did not answer) rides the error channel precisely so no truthiness test can swallow it.
 */
export type InitiationCharge =
  /** A slot was spent. `used` is the day's running total INCLUDING this one, so `used === cap` is
   *  the last one of the day and the next call answers `exhausted`. */
  | { readonly kind: "charged"; readonly used: number; readonly day: string }
  /** Today's budget is gone. Nothing was charged — a refusal must never cost a slot it did not use. */
  | { readonly kind: "exhausted" }

/** The one row of `messenger_initiation`. See that table's note for why the budget is global. */
export const INITIATION_SCOPE = "global"

/**
 * Which day a moment belongs to, for the cold-start budget: the **UTC calendar date**, `YYYY-MM-DD`.
 *
 * ⚠️ **UTC, deliberately, and it is not the obvious choice.** A user-local day would reset at the
 * user's midnight, which reads nicer — and is the one property a durable counter must not have. The
 * local day is a function of the machine's timezone, so a laptop that crosses a timezone, a DST
 * transition, or a `TZ` change would move the boundary underneath a counter that has already been
 * charged, and moving it BACKWARDS mints a second budget for one real day. UTC is a pure function of
 * the instant: no zone, no DST, no ambiguous hour. The cap is an anti-spam pacing device, not an
 * appointment — nothing about it needs to align with the user's breakfast.
 *
 * ⚠️ And ISO dates compare lexicographically the way they compare chronologically, which is what lets
 * `chargeInitiation` do "roll over only FORWARD" as a plain `>` inside SQL.
 */
export const initiationDay = (at: number): string => new Date(at).toISOString().slice(0, 10)

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
    // NULL on either column is not a missing value to paper over: no proposal means the driver had
    // no evidence, and no declaration means nobody has chosen. Both are `Source.UNLABELLED`'s state.
    access: {
      proposed: row.proposed_access ?? "unknown",
      ...(row.declared_access === null ? {} : { declared: row.declared_access }),
    },
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
 * *consumer* chooses what an unreadable database means for it. The relay says "an empty result";
 * the containment guard says "unknown"; the gateway's reconcile says "change nothing"; the tool
 * says it out loud to the model — and those are four different decisions, not one.
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
        : Log.event("messenger.store.read.failed", {
            "messenger.operation": what,
            "messenger.cause": Cause.pretty(cause),
          }).pipe(Effect.flatMap(() => Effect.fail(new UnavailableError({ read: what, detail: Cause.pretty(cause) })))),
    ),
  )

/** What a read that may not have happened looks like once a consumer has taken responsibility for
 *  it: `read` says whether the database answered at all, `value` is only meaningful when it did. */
export type Attempt<A> =
  | { readonly read: true; readonly value: A }
  | { readonly read: false; readonly value: undefined }

/**
 * Adapt a fallible read into an explicit *did this read happen?* pair — the one shape a consumer
 * cannot accidentally treat as an answer.
 *
 * ⚠️ It lives HERE, exported, rather than as a four-line closure in each consumer, for the reason
 * ruling 6 gives: a helper copied into two modules is how two modules come to disagree. And it
 * deliberately does NOT take a fallback — the `failClosed(fallback)` helper this family started as
 * was replaced precisely because a fallback parameter let one call site's fail-closed empty become
 * another's permissive default, invisibly, with the signature unable to tell the two apart. Here
 * the consumer must branch on `read` in its own code, where the reason for its choice is written.
 */
export const attempted = <A>(query: Effect.Effect<A, UnavailableError>): Effect.Effect<Attempt<A>> =>
  query.pipe(
    Effect.map((value): Attempt<A> => ({ read: true, value })),
    Effect.orElseSucceed((): Attempt<A> => ({ read: false, value: undefined })),
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
      // ⚠️ NOT `Effect.orDie`, and NOT a silent `[]`: an empty account list is the product's
      // "no messenger accounts are set up" AND the gateway's cue to disconnect everything.
      listAccounts: Effect.fn("MessengerStore.listAccounts")(function* () {
        const rows = yield* nameTheFault(db.select().from(MessengerAccountTable).all(), "listAccounts()")
        return rows.map(accountFromRow)
      }),
      getAccount: Effect.fn("MessengerStore.getAccount")(function* (id) {
        const row = yield* db
          .select()
          .from(MessengerAccountTable)
          .where(eq(MessengerAccountTable.id, id))
          .get()
          .pipe(Effect.orDie)
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
            proposed_access: input.proposedAccess ?? "unknown",
          })
          .onConflictDoUpdate({
            target: [MessengerChatTable.account_id, MessengerChatTable.chat_id],
            // ⚠️ `declared_access` is ABSENT from this set, and that absence is the mechanism, not an
            // omission (ruling 7). Every inbound message and every `listChats` runs through here, so
            // including it would let a driver's guess silently overwrite the user's own word on the
            // next sighting — a proposal becoming a declaration by attrition. Pinned by
            // "a driver sighting never overwrites the user's declaration" in
            // core/test/messenger-source-access.test.ts, negative-controlled.
            set: {
              kind: input.kind,
              title: input.title,
              last_seen: input.at,
              proposed_access: input.proposedAccess ?? "unknown",
            },
          })
          .run()
          .pipe(Effect.orDie)
      }),
      getChat: Effect.fn("MessengerStore.getChat")(function* (accountID, chatID) {
        // ⚠️ Typed-fallible on purpose, like `hasChat` next door: the gateway's ruling-7 gate asks
        // this "is it safe to quote?" and `undefined` would answer "no such chat" for a read that
        // never happened. The gate must be able to tell those apart to refuse under its own name.
        const row = yield* nameTheFault(
          db
            .select()
            .from(MessengerChatTable)
            .where(and(eq(MessengerChatTable.account_id, accountID), eq(MessengerChatTable.chat_id, chatID)))
            .get(),
          `getChat(${accountID}, ${chatID})`,
        )
        return row === undefined ? undefined : chatFromRow(row)
      }),
      declareChatAccess: Effect.fn("MessengerStore.declareChatAccess")(function* (input) {
        const row = yield* db
          .select()
          .from(MessengerChatTable)
          .where(and(eq(MessengerChatTable.account_id, input.accountID), eq(MessengerChatTable.chat_id, input.chatID)))
          .get()
          .pipe(Effect.orDie)
        // Never invents the row. A declaration about a chat this instance has never seen is a
        // typo or a stale UI, and answering `false` lets the caller say so instead of creating a
        // ghost chat with no kind, no title and a privacy verdict attached to it.
        if (row === undefined) return false
        yield* db
          .update(MessengerChatTable)
          .set({ declared_access: input.access ?? null })
          .where(and(eq(MessengerChatTable.account_id, input.accountID), eq(MessengerChatTable.chat_id, input.chatID)))
          .run()
          .pipe(Effect.orDie)
        return true
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
      // ⚠️ NOT `Effect.orDie`, and NOT a silent `false`: `false` is "this chat has never messaged
      // us", which the gateway states to the model as fact. See the interface note.
      hasChat: Effect.fn("MessengerStore.hasChat")(function* (accountID, chatID) {
        const row = yield* nameTheFault(
          db
            .select()
            .from(MessengerChatTable)
            .where(and(eq(MessengerChatTable.account_id, accountID), eq(MessengerChatTable.chat_id, chatID)))
            .get(),
          `hasChat(${accountID}, ${chatID})`,
        )
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
        if (existing !== undefined)
          return yield* Effect.fail(new ChatAlreadyBoundError({ sessionID: existing.session_id }))
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
      // ⚠️ NOT `Effect.orDie`, and NOT a silent `undefined`: `undefined` is "this chat drives no
      // session", and one of its readers WRITES on the strength of that. See the interface note.
      bindingForChat: Effect.fn("MessengerStore.bindingForChat")(function* (accountID, chatID) {
        const row = yield* nameTheFault(
          db
            .select()
            .from(MessengerBindingTable)
            .where(and(eq(MessengerBindingTable.account_id, accountID), eq(MessengerBindingTable.chat_id, chatID)))
            .get(),
          `bindingForChat(${accountID}, ${chatID})`,
        )
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

      // ⚠️ NOT `Effect.orDie`, and NOT a silent `exhausted`/`charged`: both are claims about the
      // day's cold outreach, and one of them puts an uncounted DM on the owner's real account.
      // See the interface note; the SQL below is explained line by line because every clause of it
      // is load-bearing.
      chargeInitiation: Effect.fn("MessengerStore.chargeInitiation")(function* (input) {
        // ⚠️ A cap below one is answered WITHOUT touching the table, and this is not paranoia about
        // an input nobody passes — it closes a real hole in the statement below. `setWhere` governs
        // the DO UPDATE arm only; the plain INSERT arm (the day's very first charge, when no row
        // exists yet) is not filtered by it, so a zero cap would still hand out one cold start per
        // day. Nothing passes zero today — but "set the cap to 0 to stop initiating" is the obvious
        // next feature, and it would ship silently broken.
        if (input.cap < 1) return { kind: "exhausted" } satisfies InitiationCharge
        const today = initiationDay(input.at)
        // Unqualified column references: inside `DO UPDATE SET` a bare name is the EXISTING row's
        // value (`excluded.x` would be the one we tried to insert), which is what both CASEs want.
        const day = sql.identifier(MessengerInitiationTable.day.name)
        const count = sql.identifier(MessengerInitiationTable.count.name)
        const rows = yield* nameTheFault(
          db
            .insert(MessengerInitiationTable)
            .values({
              scope: INITIATION_SCOPE,
              day: today,
              count: 1,
              time_created: input.at,
              time_updated: input.at,
            })
            .onConflictDoUpdate({
              target: MessengerInitiationTable.scope,
              set: {
                // ⚠️ **Rolls over only FORWARD** (`today > day`, never `today !== day`). A clock that
                // jumps BACKWARDS — an NTP correction, a user fixing the date, a VM resuming from a
                // snapshot — would otherwise look exactly like a new day and hand out a second budget
                // for one real day. Keeping the later stored day means a backwards jump charges the
                // bucket that is already running, which is the fail-closed direction. (A jump
                // FORWARDS past midnight does mint a fresh bucket, and nothing durable can prevent
                // that without a monotonic clock we do not have across restarts; it is the same
                // exposure the in-memory version had, minus the restart one this table removes.)
                day: sql`CASE WHEN ${today} > ${day} THEN ${today} ELSE ${day} END`,
                count: sql`CASE WHEN ${today} > ${day} THEN 1 ELSE ${count} + 1 END`,
                time_updated: input.at,
              },
              // THE CAP, enforced by SQLite rather than by us. A `DO UPDATE` whose `WHERE` is false
              // is skipped — no update, no constraint error, and (the part that makes this work) no
              // `RETURNING` row. So an empty result IS "today's budget is gone", established in the
              // same statement that would have spent the slot. Nothing between the test and the
              // charge can interleave, because there is no "between".
              setWhere: sql`${today} > ${day} OR ${count} < ${input.cap}`,
            })
            .returning({ day: MessengerInitiationTable.day, count: MessengerInitiationTable.count })
            .all(),
          `chargeInitiation(${today})`,
        )
        const charged = rows[0]
        return charged === undefined
          ? ({ kind: "exhausted" } satisfies InitiationCharge)
          : ({ kind: "charged", used: charged.count, day: charged.day } satisfies InitiationCharge)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
