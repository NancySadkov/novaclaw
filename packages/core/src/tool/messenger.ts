export * as MessengerTool from "./messenger"

import fs from "node:fs/promises"
import path from "node:path"
import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import type { ModerationAct } from "../messenger/driver"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { HostExec } from "../host-exec"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { MessengerDrivers } from "../messenger/drivers"
import { MessengerGatewayHandle } from "../messenger/gateway-handle"
import { MessengerPipeline } from "../messenger/pipeline"
import { MessengerStore } from "../messenger/store"
import { PermissionV2 } from "../permission"
import { EFFECTIVE_CONFIG_DEFAULTS, resolveSessionConfig } from "../session/config-resolve"
import { SessionOrigin } from "../session/origin"
import { SessionStore } from "../session/store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// The `messenger` tool (notes/messenger-plan.md §4) — the model-facing surface of the Messenger
// module. ONE tool, a closed op vocab (kb.ts is the template): `status` → `chats` → `history` are
// reads; `send` is governed by the traffic rules (§2.3 — paced, cold-start-guarded) and
// permission-gated. Results are LINEARIZED text lines, never nested JSON; a miss settles as
// readable repair text the model can act on (the JH floor); ToolFailure stays for infra.
//
// ⚠️ Singleton + module-graph discipline: this module must NEVER import messenger/gateway.ts —
// that edge closes the import cycle tool → gateway → session.ts → location-services → builtins →
// tool. The ONE live gateway publishes a runtime handle instead (gateway-handle.ts, set on build,
// cleared on teardown); reading it at call time also makes a second-gateway wiring impossible
// from the tool side (edge #16). No gateway running → the ops degrade legibly.

export const name = "messenger"

const StatusOp = Schema.Struct({
  op: Schema.Literal("status"),
})

const ChatsOp = Schema.Struct({
  op: Schema.Literal("chats"),
  account: Schema.String.pipe(Schema.optional).annotate({
    description: "Account id (msa_…) or its label — omit when only one account exists",
  }),
})

const HistoryOp = Schema.Struct({
  op: Schema.Literal("history"),
  chat: Schema.String.annotate({ description: "Chat id (from `chats`) whose recent messages to fetch" }),
  account: Schema.String.pipe(Schema.optional).annotate({
    description: "Account id (msa_…) or label — omit when only one account exists",
  }),
  limit: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max messages (default 50, cap 200)" }),
  purpose: Schema.Literals(["correspondence", "research"])
    .pipe(Schema.optional)
    .annotate({
      description:
        "What this read is FOR. 'correspondence' (the default) = handling the user's own messages, and " +
        "stays inside this conversation. 'research' = the content may be quoted or cited in something " +
        "that leaves this chat — allowed ONLY for chats the user has marked as a public source, and " +
        "refused with a reason otherwise. Say 'research' whenever you intend to cite it.",
    }),
})

const SendOp = Schema.Struct({
  op: Schema.Literal("send"),
  chat: Schema.String.annotate({ description: "Chat id (from `chats`) to write into" }),
  text: Schema.String.annotate({ description: "The message text — sent AS the user, paced at human typing speed" }),
  reply: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Message id this answers (from the `msg …` in a message header, or from history) — attaches the reply to that message. Use it in busy group chats so people can tell what you're answering.",
  }),
  initiate: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Set true ONLY to START a conversation with someone who has never written to this account (a cold " +
      "first contact). It asks the USER for permission every time, and only a small number of new " +
      "conversations are allowed per day. Leave it off for every reply and for every chat that has " +
      "already messaged you — and prefer asking the person to message first, which needs no permission " +
      "at all. It cannot be used from a chat belonging to a client or an audience.",
  }),
  account: Schema.String.pipe(Schema.optional).annotate({
    description: "Account id (msa_…) or label — omit when only one account exists",
  }),
})

const ConnectOp = Schema.Struct({
  op: Schema.Literal("connect"),
  chat: Schema.String.annotate({
    description: "Chat id (from `chats`) to bind THIS session to — inbound messages become your turns",
  }),
  trust: Schema.Literals(["operator", "client", "audience"]).annotate({
    description:
      "Who is on the other side — operator (you/family, full control), client (a customer whose requests you treat carefully), or audience (the public you only moderate). REQUIRED — ask the user if unsure.",
  }),
  account: Schema.String.pipe(Schema.optional).annotate({
    description: "Account id (msa_…) or label — omit when only one account exists",
  }),
  force: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Set true ONLY after confirming with the user, to bind an untrusted client/audience chat to a session that auto-approves everything (bypass/yolo permission mode).",
  }),
})

const DisconnectOp = Schema.Struct({
  op: Schema.Literal("disconnect"),
  chat: Schema.String.pipe(Schema.optional).annotate({
    description: "Chat id to unbind (default: this session's binding)",
  }),
  account: Schema.String.pipe(Schema.optional).annotate({
    description: "Account id or label — omit when only one account exists",
  }),
})

const UploadOp = Schema.Struct({
  op: Schema.Literal("upload"),
  chat: Schema.String.annotate({ description: "Chat id (from `chats`) to send the file into" }),
  path: Schema.String.annotate({ description: "Workspace file to send (relative to this session's folder)" }),
  caption: Schema.String.pipe(Schema.optional).annotate({ description: "Short text sent with the file" }),
  account: Schema.String.pipe(Schema.optional).annotate({
    description: "Account id (msa_…) or label — omit when only one account exists",
  }),
})

const DownloadOp = Schema.Struct({
  op: Schema.Literal("download"),
  chat: Schema.String.annotate({ description: "Chat id the message with the attachment is in" }),
  message: Schema.String.annotate({
    description: "Message id carrying the attachment (shown in message headers and history)",
  }),
  path: Schema.String.pipe(Schema.optional).annotate({
    description: "Where to save it, relative to this session's folder (default: downloads/<original name>)",
  }),
  account: Schema.String.pipe(Schema.optional).annotate({
    description: "Account id (msa_…) or label — omit when only one account exists",
  }),
})

const ModerateOp = Schema.Struct({
  op: Schema.Literal("moderate"),
  chat: Schema.String.annotate({ description: "Chat id (from `chats`) the moderation acts in" }),
  act: Schema.Literals(["delete", "ban", "kick", "mute", "pin", "approve", "lock"]).annotate({
    description:
      "delete a message · ban/kick/mute a member (needs a SERVER chat) · pin a message · approve a removed or reported item back into the listings · lock this chat against new replies. Not every platform has every act — a miss comes back saying so.",
  }),
  message: Schema.String.pipe(Schema.optional).annotate({
    description: "Message id — required for delete, pin and approve",
  }),
  user: Schema.String.pipe(Schema.optional).annotate({ description: "User id — required for ban, kick, and mute" }),
  seconds: Schema.Finite.pipe(Schema.optional).annotate({
    description:
      "For mute: how long the timeout lasts (default 600, platform-capped). For ban: ALSO delete that member's messages from the last N seconds, where the platform can (a spam wave) — not every platform can, and one that can't says so.",
  }),
  days: Schema.Finite.pipe(Schema.optional).annotate({
    description:
      "Ban only: make it temporary, this many days. Platforms without temporary bans refuse rather than ban forever.",
  }),
  account: Schema.String.pipe(Schema.optional).annotate({
    description: "Account id (msa_…) or label — omit when only one account exists",
  }),
})

export const Input = Schema.Union([
  StatusOp,
  ChatsOp,
  HistoryOp,
  SendOp,
  ConnectOp,
  DisconnectOp,
  UploadOp,
  DownloadOp,
  ModerateOp,
])

/** Build the driver `ModerationAct` from the flat op, validating the target this act needs. Pure. */
export const buildModerationAct = (input: {
  readonly act: "delete" | "ban" | "kick" | "mute" | "pin" | "approve" | "lock"
  readonly message?: string
  readonly user?: string
  readonly seconds?: number
  readonly days?: number
}): ModerationAct | { readonly error: string } => {
  const message = input.message?.trim()
  const user = input.user?.trim()
  switch (input.act) {
    case "delete":
      return message
        ? { act: "delete", messageID: message }
        : { error: "delete needs a message id (from history/chat headers)." }
    case "pin":
      return message ? { act: "pin", messageID: message } : { error: "pin needs a message id." }
    case "approve":
      return message
        ? { act: "approve", messageID: message }
        : { error: "approve needs the message id of the item to restore." }
    case "lock":
      // Locking targets the CHAT the op already names — no message id to ask for.
      return { act: "lock" }
    case "ban":
      return user
        ? {
            act: "ban",
            userID: user,
            ...(input.seconds === undefined ? {} : { purgeSeconds: Math.max(0, Math.floor(input.seconds)) }),
            ...(input.days === undefined ? {} : { durationDays: Math.max(1, Math.floor(input.days)) }),
          }
        : { error: "ban needs a user id." }
    case "kick":
      return user ? { act: "kick", userID: user } : { error: "kick needs a user id." }
    case "mute":
      return user
        ? {
            act: "mute",
            userID: user,
            ...(input.seconds === undefined ? {} : { seconds: Math.max(1, Math.floor(input.seconds)) }),
          }
        : { error: "mute needs a user id." }
  }
}

/**
 * What the model is told — THREE outcomes, because "that didn't work" and "this instance is broken"
 * call for different next actions and a small model cannot infer the difference from prose.
 *
 * ⚠️ **The field is `outcome`, and it used to be `ok: Schema.Boolean`. That rename is the check.**
 * A boolean cannot express three states at all, and the two workarounds both fail: a third *value*
 * on `ok` would be TRUTHY, so every `if (!outcome.ok)` fold in this file would have routed it to the
 * SUCCESS branch and reported "Sent (paced at human typing speed)." for a message nobody sent; a
 * boolean plus a side-channel flag leaves those folds compiling untouched. Renaming the field turned
 * all ~30 construction and fold sites into compile errors, which is how each got looked at exactly
 * once (ruling 1: the invariant ships with its mechanical check, and the compiler is one).
 *
 * `failed` is "your request did not go through" — the model should try something else. `unavailable`
 * is narrower than it sounds: **a read this instance could not perform**, never a subsystem that is
 * merely switched off. An airgapped or not-yet-started gateway (`OFFLINE_GATEWAY`) stays `failed`,
 * because it already names itself accurately and retrying may well work; `unavailable` is reserved
 * for "we could not find out", where `modelText` adds the horizon that retrying will not help.
 */
const Output = Schema.Struct({
  outcome: Schema.Literals(["ok", "failed", "unavailable"]),
  message: Schema.String,
})
type Output = typeof Output.Type

/**
 * The ONE place the three outcomes become the sentence a model actually reads (`toModelOutput`).
 *
 * A small local model's failure mode here is the retry loop: told only "the messenger database
 * could not be read", it calls the tool again, and again. Per AGENTS.md's Juvenile Harness thesis
 * the harness owns the horizon the model lacks, so `unavailable` carries the horizon explicitly —
 * nothing happened, retrying will not change that, and the action that WOULD help is a human one.
 * Exported so the wording is pinned by a test rather than by whoever reads the file next.
 */
export const modelText = (output: Output): string =>
  output.outcome === "unavailable"
    ? `${output.message}\nNothing was sent and nothing was changed. Calling this tool again will not help until that is fixed — tell the user what is broken, and use another way to reach anyone waiting if it is urgent.`
    : output.message

/**
 * ⭐ MAY A TURN ON THIS SESSION START A CONVERSATION NOBODY INVITED? (AGENTS.md #9(b).)
 *
 * 9(b) has two halves. The default — *never cold-start* — has always been enforced at the gateway.
 * The other half, *starting one needs **explicit permission** and its own stricter rate limit*, was
 * half-built: the rate limit is `DAILY_NEW_CONVERSATION_CAP`, and the permission did not exist. This
 * function plus the `messenger.initiate` assert in `send` are that missing half.
 *
 * ⚠️ **"Explicit permission" is the OPERATOR's, and a correspondent must never be able to trigger
 * it.** The standing decision *System commands are the OPERATOR's surface, never the correspondent's*
 * is this same shape one layer up: a remote human's message is evaluated by the model, and the model
 * acts through permission-gated tools — so the gate has to hold while the model is arguing on a
 * stranger's behalf. A client or audience chat talking the agent into cold-DMing a third party is
 * exactly the havoc principle 9 exists to prevent, and **a consent card is not an adequate answer to
 * it**: the operator would be asked to approve an initiation they never wanted, prompted by words the
 * stranger effectively wrote, on a surface (Allow / Always allow) built for their own requests. So a
 * hostile chain is refused HERE, before any card is raised — deny-fast, the same reasoning
 * `tool/bash.ts` uses for its jail decision.
 *
 * ⚠️ **Three answers, not two, and `"unknown"` refuses.** `HostExec.chainHasHostileBinding` walks the
 * WHOLE parent chain (the recommended messenger pattern — a bound session spawning a worker — puts
 * the binding on an ancestor) and reports `"unknown"` when a link could not be read. Only a chain
 * read end to end with nothing untrusted on it may initiate. That collapse is deliberately identical
 * to `HostExec.takesUnattendedArm`'s (unknown contains rather than permits — ruling 2), and it is
 * restated here rather than imported for two reasons: that helper is module-private, and the QUESTION
 * differs — the jail asks *may this command run with the host user's authority*, this asks *may this
 * turn write to a person who never asked to hear from us*. Keeping the answer in one exported
 * function is what stops the two from drifting inside this file.
 *
 * ⚠️ **The two refusals differ in OUTCOME, not merely in wording.** A hostile chain is a fact we
 * established, so the request `failed` and the model should do something else. An unreadable chain is
 * a question this instance could not answer, so it is `unavailable` — and `modelText` then supplies
 * the horizon that retrying will not help. Describing the second as the first would blame a chat that
 * may not exist for a database fault, which is ruling 2's *a fault is never described falsely*.
 *
 * Returns `undefined` when the turn is clear to ask for permission — never `true`, so that "no
 * refusal" cannot be mistaken for "already allowed". The permission assert is a separate step.
 */
export const initiationRefusal = (hostility: HostExec.Hostility): Output | undefined => {
  if (hostility === false) return undefined
  if (hostility === "unknown")
    return {
      outcome: "unavailable",
      message:
        "I couldn't start a new conversation: this instance's messenger database can't be read, so I " +
        "can't tell whether this session is being driven by somebody else's chat. Writing to a person " +
        "who has never messaged us is only allowed when that question has an answer, so nothing was " +
        "sent and nothing was lost. The user can check Settings → Messengers.",
    } satisfies Output
  return {
    outcome: "failed",
    message:
      "I can't start a new conversation from this session: it is driven by a messenger chat belonging " +
      "to a client or an audience rather than to the user. Writing to someone uninvited on the user's " +
      "account is theirs to ask for, in NovaClaw itself — not something a correspondent can request " +
      "through a chat. Nothing was sent. Answer inside this conversation instead, or ask the person to " +
      "message this account first.",
  } satisfies Output
}

/** Said whenever the messenger store itself could not answer. It names the subsystem and says the
 *  fault is the instance's, not the request's — the "unavailable subsystem names itself" half of
 *  ruling 2, in the words a model has to act on. */
const STORE_UNAVAILABLE =
  "This instance's messenger database could not be read, so I can't tell which accounts, chats or " +
  "bindings exist. That is a fault in this NovaClaw instance, not in your request — the user can " +
  "check Settings → Messengers."

// --- linearized rendering (pure; unit-tested) --------------------------------------------------

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim()

const statusLine = (status: Messenger.AccountStatus): string => {
  switch (status.state) {
    case "connected":
      return "connected"
    case "connecting":
      return "connecting"
    case "backoff":
      return `reconnecting (${status.message})`
    case "challenge":
      return `needs the operator (${status.message})`
    case "error":
      return `error (${status.message})`
    case "disabled":
      return "off"
    case "airgapped":
      return "off (airgapped)"
  }
}

/** The ruling-7 source label, rendered on the ONE line the model reads a chat from. It is a LABEL,
 *  not a filter: the operator's own chats stay listed (reading your own mail is the product), and
 *  what the label decides is whether the chat may be quoted OUTSIDE this conversation. */
const accessTag = (access: Messenger.SourceLabel): string => {
  const decision = Messenger.Source.resolve(access)
  if (decision.access === "public") return "public source"
  if (decision.access === "private") return "private — never cite"
  return access.proposed === "public" ? "unconfirmed — not citable" : "unlabelled — not citable"
}

/**
 * ⚠️ **The two functions below are the FIFTH untrusted-input seam** — ledgered as named debt in
 * `test/untrusted-framing.test.ts` until 2026-07-31, closed here.
 *
 * `webfetch`, `websearch` and the MCP adapter frame the bytes they bring in from a third party. This
 * file brings in bytes too — a correspondent's prose and a chat's name — and a tool result is the
 * same door into the context window that a messenger *turn* is. The turn side has been framed since
 * P6 (`SessionOrigin.modelHeader` + `CLIENT_FRAME`/`AUDIENCE_FRAME`); these two functions are the
 * tool side of the identical hazard, so they get the identical vocabulary.
 *
 * ⚠️ **The frame lives HERE and not in `modelText`/`toModelOutput`, deliberately.** Every *other*
 * `Output.message` this file produces is OUR OWN words — `STORE_UNAVAILABLE`, `OFFLINE_GATEWAY`,
 * "Sent (paced at human typing speed).", the bypass-bind refusal, "No chats are visible on that
 * account yet." Framing at the tool's projection would label this instance's own faults as a
 * stranger's text: ruling 2's *a fault is never described falsely*, pointed the other way. These two
 * functions are the only places third-party bytes are rendered, so they are the only places the
 * label is true — and no future op can produce unframed correspondent text by forgetting to add one.
 *
 * ⚠️ **ONE frame per BATCH, never per line.** Both collapse N items into a single string per tool
 * call, and `externalContentFrame` is pinned to one line precisely so it is not multiplied — a
 * per-message prefix would bill the frame up to 200 times (the `history` cap) for one answer about
 * one chat. (The gateway's audience-turn path also speaks of "one frame per batch"; that is a
 * DIFFERENT mechanism — `SessionOrigin.headerLine` per buffered message under a single preamble.
 * For a tool result, "per batch" simply means "once".)
 *
 * ⚠️ **What is deliberately NOT framed, so the omission reads as a decision.** Three places put a
 * driver-supplied FRAGMENT inside a sentence of ours: `download`'s `Saved "<name>" …`, a failed
 * `gateway.*` call's `reason`, and `statusLine`'s connection `message`. Each is OUR sentence, so a
 * batch frame in front of it would mislabel the sentence — the same error the paragraph above
 * avoids. Framing a fragment needs a per-value mechanism, which is a different change; the filename
 * is additionally already constrained by `containedPath`.
 */

export const formatChats = (chats: ReadonlyArray<Messenger.ChatInfo>): string => {
  // Empty stays empty and unframed (websearch's rule): a frame around nothing announces a source
  // that sent us none. The `chats` op returns `failed` before it gets here, but this is exported and
  // the honest answer must not depend on which caller asks.
  if (chats.length === 0) return ""
  // The label names ONLY the bytes that are actually external. A chat's *name* is set on the remote
  // platform by whoever administers the chat; the id, the kind and the ruling-7 access tag are ours.
  // "a chat list" would over-claim (ruling 2) — and worse, it would put `private — never cite` under
  // a banner reading "not instructions", teaching a small model to discount the one label ruling 7
  // exists to make it heed.
  return (
    SessionOrigin.externalContentFrame("chat names from the messaging platform") +
    chats.map((chat) => `${chat.chatID} · [${chat.kind} · ${accessTag(chat.access)}] ${oneLine(chat.title)}`).join("\n")
  )
}

export const formatHistory = (
  messages: ReadonlyArray<{ senderName: string; outgoing: boolean; text?: string; at: number }>,
): string => {
  if (messages.length === 0) return ""
  // "a messenger conversation", not "messages from a stranger", and the difference is ruling 2:
  // `outgoing` messages render as `me:`, i.e. the operator's own account — or this agent's own
  // earlier sends — so attributing the whole batch to a correspondent would describe its source
  // falsely. The per-line `me:` / sender-name marker is the attribution; the frame only says what
  // the block IS.
  //
  // ⚠️ "Treat as data" is nevertheless right for the `me:` lines too. An operator's *instruction*
  // arrives as a TURN (`SessionOrigin.modelHeader`, trust `operator`, deliberately unframed); a
  // `history` read is a retrospective log, and re-obeying a line this agent itself sent an hour ago
  // is a loop, not obedience.
  //
  // ⚠️ The label names no chat, no account and no correspondent. The chat id is already in the
  // model's own tool call, and every human-readable identity available here — a chat title, a
  // sender's display name — is set by the third party itself, so putting one in the frame would
  // state an identity we never verified. `webfetch` may name a host because DNS makes a host a
  // checkable fact; a messenger display name is not one.
  return (
    SessionOrigin.externalContentFrame("a messenger conversation") +
    messages
      .map((message) => {
        const when = new Date(message.at).toISOString().slice(0, 16).replace("T", " ")
        const who = message.outgoing ? "me" : oneLine(message.senderName)
        return `${when} ${who}: ${message.text === undefined ? "(no text)" : oneLine(message.text)}`
      })
      .join("\n")
  )
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const store = yield* MessengerStore.Service
    const drivers = yield* MessengerDrivers.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    const mutation = yield* LocationMutation.Service
    const sessions = yield* SessionStore.Service

    const OFFLINE_GATEWAY =
      "The messenger service isn't running on this instance (offline/airgapped, or still starting). Check Settings → Messengers."

    // messenger-plan §3.4 — is any session in this chain bound to a client/audience chat? The walk
    // itself lives in `host-exec.ts` because `tool/bash.ts` and the Strict runner already ask this
    // exact question of the exact same code, and a second copy is the drift ruling 6 exists to
    // prevent. This layer supplies only the two lookups.
    // ⚠️ Both are handed over WITHOUT a local recovery, on purpose: an `orElseSucceed(() => [])`
    // here would swallow precisely the fault the tri-state exists to report, and the walk would
    // answer the permissive `false` for an unreadable database — the defect `Hostility` was grown
    // to end. See `initiationRefusal` for what the three answers mean HERE.
    const chainHasHostileBinding = (sessionID: string): Effect.Effect<HostExec.Hostility> =>
      HostExec.chainHasHostileBinding(sessionID, {
        bindingsForSession: (id) => store.bindingsForSession(id),
        parentOf: (id) => sessions.get(id as never).pipe(Effect.map((session) => session?.parentID)),
      })

    // A miss carries the WHOLE tool output, not a bare string, so the op that hands it back cannot
    // lose which of the three outcomes it was. `{ error: string }` could only ever mean "failed",
    // which is how "the database is unreadable" used to arrive at the model as "no messenger
    // accounts are set up. Ask the user to add one" — a fault reported as a setup instruction.
    type Resolved =
      | { readonly miss: Output; readonly account?: undefined }
      | { readonly miss?: undefined; readonly account: Messenger.AccountInfo }

    // Resolve the account by id, label, or driver id — or the sole account when unambiguous.
    const resolveAccount = (
      selector: string | undefined,
      allowed?: ReadonlySet<Messenger.AccountID>,
    ): Effect.Effect<Resolved> =>
      Effect.gen(function* () {
        const listed = yield* MessengerStore.attempted(store.listAccounts())
        if (!listed.read) return { miss: { outcome: "unavailable", message: STORE_UNAVAILABLE } satisfies Output }
        const accounts =
          allowed === undefined ? listed.value : listed.value.filter((account) => allowed.has(account.id))
        if (accounts.length === 0)
          return {
            miss: {
              outcome: "failed",
              message: "No messenger accounts are set up. Ask the user to add one in Settings → Messengers.",
            } satisfies Output,
          }
        if (selector === undefined) {
          if (accounts.length === 1) return { account: accounts[0]! }
          return {
            miss: {
              outcome: "failed",
              message:
                `Several accounts exist — name one: ` +
                accounts.map((account) => `${account.id} (${account.label})`).join(", "),
            } satisfies Output,
          }
        }
        const wanted = selector.trim().toLowerCase()
        const match = accounts.find(
          (account) =>
            account.id.toLowerCase() === wanted ||
            account.label.toLowerCase() === wanted ||
            account.driverID.toLowerCase() === wanted,
        )
        if (match === undefined)
          return {
            miss: {
              outcome: "failed",
              message:
                `No account matches "${selector}". Known: ` +
                accounts.map((account) => `${account.id} (${account.label})`).join(", "),
            } satisfies Output,
          }
        return { account: match }
      })

    type ReadScope = false | "unknown" | ReadonlySet<string>
    const readScope = (sessionID: string): Effect.Effect<ReadScope> =>
      chainHasHostileBinding(sessionID).pipe(
        Effect.flatMap((hostility): Effect.Effect<ReadScope> => {
          if (hostility !== true) return Effect.succeed(hostility)
          return Effect.gen(function* () {
            const resources = new Set<string>()
            const seen = new Set<string>()
            let id: string | undefined = sessionID
            while (id !== undefined && !seen.has(id)) {
              seen.add(id)
              const bindings = yield* store.bindingsForSession(id)
              for (const binding of bindings) {
                if (binding.status !== "active" || binding.trust === "operator") continue
                resources.add(`${binding.accountID}:${binding.chatID}`)
              }
              id = (yield* sessions.get(id as never))?.parentID
            }
            return resources
          }).pipe(Effect.orElseSucceed(() => "unknown" as const))
        }),
      )

    const scopedReadRefusal = (scope: ReadScope, resource?: string): Output | undefined => {
      if (scope === false) return undefined
      if (scope === "unknown") return { outcome: "unavailable", message: STORE_UNAVAILABLE }
      if (resource !== undefined && scope.has(resource)) return undefined
      return {
        outcome: "failed",
        message:
          "This session is being driven by a client or audience conversation, so it may read only that bound conversation. Other accounts and chats stay private.",
      }
    }
    const scopedAccounts = (scope: ReadScope): ReadonlySet<Messenger.AccountID> | undefined =>
      scope instanceof Set
        ? new Set([...scope].map((resource) => Messenger.AccountID.make(resource.slice(0, resource.indexOf(":")))))
        : undefined

    /**
     * Contain a caller-supplied path to this session's workspace, CANONICALLY.
     *
     * The lexical check this replaces (`path.resolve` + `FSUtil.contains`) does not resolve symlinks, so a
     * link inside the workspace pointing outside slipped through — on upload that reads a file outside and
     * transmits it to a chat, on download it writes outside. `LocationMutation.resolve` canonicalizes via
     * realPath and is what every other file tool already uses, so this closes the one place that differed.
     *
     * Messenger keeps its stricter posture deliberately: an external path is REFUSED outright rather than
     * raised as an ask. Sending a file to the outside world is not something to negotiate mid-turn.
     */
    const containedPath = Effect.fn("MessengerTool.containedPath")(function* (raw: string) {
      const target = yield* mutation.resolve({ path: raw, kind: "file" }).pipe(Effect.orElseSucceed(() => undefined))
      if (target === undefined || target.externalDirectory !== undefined) return undefined
      return target.canonical
    })

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            sideEffect: "non-idempotent",
            description:
              "Read and send the user's real messages AND EMAILS through their connected accounts — chat " +
              "apps (Telegram, Discord, IRC) AND email mailboxes (Gmail, Outlook, any IMAP account). THIS " +
              "TOOL IS your access to the user's email and messaging. Whenever the user mentions email, mail, " +
              "their inbox, Gmail/Outlook, a chat, or 'my messages', do NOT assume you have no access — START " +
              'by calling {"op":"status"} to see which accounts are actually connected. ' +
              "Ops: status (connected accounts + connection state + this session's bindings) · chats (list an " +
              "account's conversations / recent EMAIL THREADS — subjects + senders; ids feed the other ops) · " +
              "history (recent messages / emails of one chat or thread, oldest first — use it to read and " +
              "summarize a mailbox or conversation) · send (write into a chat / reply to an email thread AS the " +
              "user, paced at human speed; writing to a chat that has never messaged this account is a COLD " +
              "START — refused unless you pass initiate:true, which asks the user for permission and is " +
              "strictly capped per day, so prefer asking people to message first) · connect (bind THIS session " +
              "to a chat/thread — pick a trust tier) · " +
              "disconnect · upload (send a workspace file, optional caption) · download (save an attachment) · " +
              "moderate (delete a message, or ban/kick/mute/pin a member — for chats you moderate, where the " +
              "platform supports it). " +
              'To summarize a mailbox: {"op":"status"} → {"op":"chats","account":"<id or label>"} (recent ' +
              'threads) → optionally {"op":"history","chat":"<id>"} for bodies → summarize. ' +
              "The user's messages and emails are private: handle them inside this workspace and never forward " +
              "them anywhere without being asked. " +
              "ALSO USE THIS TOOL AS A RESEARCH SOURCE — it reads platforms the open web cannot. Many sources " +
              "publish ONLY inside a chat platform: Telegram channels, Discord announcement/news channels " +
              "(indie studios often post releases there before anywhere else), subreddits. Their web pages are " +
              "JavaScript-only or blocked, so webfetch returns an empty shell. When research leads to one of " +
              'those and the account is connected, read it HERE: {"op":"chats","account":"<id>"} to find the ' +
              'channel, then {"op":"history","chat":"<id>"} for the posts. This is the SANCTIONED route — the ' +
              "user's own account reading a public channel — not scraping, so prefer it over trying to fetch " +
              "the platform's website. Cite the channel and post date like any other source. " +
              '⚠️ For RESEARCH, pass purpose:"research" on `history` and read ONLY chats `chats` labels ' +
              '"public source". The label is per chat and the user owns it, so the chat KIND tells you nothing ' +
              "about it: a server text channel can be a public news feed or a company's private staff room. " +
              '"private — never cite" is the user\'s correspondence and "unlabelled"/"unconfirmed" means nobody ' +
              "has said yet — in all three cases you may still read the chat as correspondence when the user " +
              "asked you to, but nothing from it may be quoted, summarized or cited outside this conversation. " +
              "If you need one of those as a source, ask the user to mark it public in Settings → Messengers; " +
              "you cannot mark it yourself, and that is deliberate.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: modelText(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const gateway = MessengerGatewayHandle.get()
                switch (input.op) {
                  case "status": {
                    // ⚠️ THE headline lie this whole change exists for. `status` is the op the tool's
                    // own description tells the model to START with, and an unreadable account table
                    // used to reach it as "No messenger accounts are set up. Ask the user to add one
                    // in Settings → Messengers" — a database fault rendered as a claim about the
                    // user's setup, on the one surface a model consults before deciding it has no
                    // messaging at all.
                    const scope = yield* readScope(context.sessionID)
                    if (scope === "unknown") return scopedReadRefusal(scope)!
                    const listed = yield* MessengerStore.attempted(store.listAccounts())
                    if (!listed.read) return { outcome: "unavailable", message: STORE_UNAVAILABLE } satisfies Output
                    const allowedAccounts = scopedAccounts(scope)
                    const accounts =
                      allowedAccounts === undefined
                        ? listed.value
                        : listed.value.filter((account) => allowedAccounts.has(account.id))
                    if (accounts.length === 0)
                      return {
                        outcome: "failed",
                        message: "No messenger accounts are set up. Ask the user to add one in Settings → Messengers.",
                      } satisfies Output
                    const status =
                      gateway === undefined
                        ? new Map<Messenger.AccountID, Messenger.AccountStatus>()
                        : yield* gateway.status()
                    // The binding half degrades on its own: the accounts above may read fine while
                    // the binding table does not, and "This chat has no remote binding" is then a
                    // statement about THIS session made from a read that failed. Reporting the
                    // accounts and naming the missing half beats withholding both.
                    const bindings = yield* MessengerStore.attempted(store.bindingsForSession(context.sessionID))
                    const bound =
                      scope instanceof Set
                        ? `This chat is privacy-scoped to ${[...scope].join(", ")}.`
                        : !bindings.read
                          ? "I could not read this instance's binding table, so I can't say whether this chat is linked to a remote chat."
                          : bindings.value.length === 0
                            ? "This chat has no remote binding."
                            : bindings.value
                                .map(
                                  (binding) =>
                                    `This chat is bound to chat ${binding.chatID} on ${binding.accountID} (${binding.trust}).`,
                                )
                                .join("\n")
                    const lines = accounts.map((account) => {
                      const driver = drivers.get(account.driverID)
                      const state = status.get(account.id)
                      return `${account.id} · ${account.label} (${driver?.meta.name ?? account.driverID}) · ${state === undefined ? "off" : statusLine(state)}`
                    })
                    return {
                      outcome: bindings.read ? "ok" : "unavailable",
                      message: `${lines.join("\n")}\n${bound}`,
                    } satisfies Output
                  }
                  case "chats": {
                    if (gateway === undefined) return { outcome: "failed", message: OFFLINE_GATEWAY } satisfies Output
                    const scope = yield* readScope(context.sessionID)
                    const refusal = scopedReadRefusal(scope)
                    if (refusal !== undefined) return refusal
                    const resolved = yield* resolveAccount(input.account)
                    if (resolved.account === undefined) return resolved.miss
                    const outcome = yield* gateway.chats(resolved.account.id)
                    if (!outcome.ok) return { outcome: "failed", message: outcome.reason } satisfies Output
                    if (outcome.chats.length === 0)
                      return {
                        outcome: "failed",
                        message: "No chats are visible on that account yet.",
                      } satisfies Output
                    return {
                      outcome: "ok",
                      message: formatChats([...outcome.chats]),
                    } satisfies Output
                  }
                  case "history": {
                    if (gateway === undefined) return { outcome: "failed", message: OFFLINE_GATEWAY } satisfies Output
                    const scope = yield* readScope(context.sessionID)
                    if (scope === "unknown") return scopedReadRefusal(scope)!
                    const resolved = yield* resolveAccount(input.account, scopedAccounts(scope))
                    if (resolved.account === undefined) return resolved.miss
                    const refusal = scopedReadRefusal(scope, `${resolved.account.id}:${input.chat.trim()}`)
                    if (refusal !== undefined) return refusal
                    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)))
                    const outcome = yield* gateway.history({
                      accountID: resolved.account.id,
                      chatID: input.chat.trim(),
                      limit,
                      // Ruling 7: the gateway's read seam decides, not this tool and not a later
                      // filter over the model's output. Absent means correspondence — the shipped
                      // behaviour, and the one that must never regress for the operator's own mail.
                      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                    })
                    if (!outcome.ok) return { outcome: "failed", message: outcome.reason } satisfies Output
                    if (outcome.messages.length === 0)
                      return { outcome: "failed", message: "That chat has no fetchable messages." } satisfies Output
                    return { outcome: "ok", message: formatHistory([...outcome.messages]) } satisfies Output
                  }
                  case "send": {
                    if (gateway === undefined) return { outcome: "failed", message: OFFLINE_GATEWAY } satisfies Output
                    const resolved = yield* resolveAccount(input.account)
                    if (resolved.account === undefined) return resolved.miss
                    const chatID = input.chat.trim()
                    const resource = `${resolved.account.id}:${chatID}`
                    // ⭐ AGENTS.md #9(b)'s OTHER half — starting a conversation. The default (never
                    // cold-start) is the gateway's; this is the "explicit permission" the rule pairs
                    // with the daily cap, and until 2026-07-31 it did not exist, so the product could
                    // not start a conversation at all.
                    const initiating = input.initiate === true
                    if (initiating) {
                      // Deny-fast, BEFORE either card. Asking the operator to approve something we are
                      // certain to refuse is a hang dressed as a gate (`tool/bash.ts`'s jail check made
                      // the same move for the same reason) — and here it is worse than wasteful, because
                      // the card would be prompted by a stranger's words. Reasoning: `initiationRefusal`.
                      const refusal = initiationRefusal(yield* chainHasHostileBinding(context.sessionID))
                      if (refusal !== undefined) return refusal
                    }
                    // Writing AS the user is consequential — permission-gated (default policy applies;
                    // the resource is the chat so saved rules can scope per conversation).
                    yield* permission.assert({
                      action: "messenger.send",
                      resources: [resource],
                      save: ["*"],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    // ⚠️ SECOND gate, and it is ADDITIONAL — never a replacement for the one above.
                    // A cold start is also a send, so a user who denied `messenger.send` for this chat
                    // must not be able to be talked into the same write through the initiate card; and
                    // conversely a saved "always allow messenger.send on *" (which is what the assert
                    // above offers) cannot satisfy this one, because the action name differs and
                    // `Wildcard.match` compares actions literally.
                    //
                    // ⚠️ `save: [resource]` — NOT `save: ["*"]`, which is what `messenger.send` uses.
                    // The asymmetry is the whole point, and `tool/recipe.ts` faced the identical
                    // question for a durable instance-global write: an "always" answered here with a
                    // wildcard would be a standing grant to COLD-DM ANYONE, FOREVER, from one card the
                    // user answered about one person. Scoped to the one chat, "always" means what a
                    // person would think it means — keep writing to THIS conversation — and every new
                    // stranger costs its own card. The daily cap still bounds the whole day on top.
                    //
                    // ⚠️ Asked on the DECLARED intent, not on a pre-flight cold/invited check. Two
                    // reasons: a check-then-send would be a TOCTOU (the invitation can change between
                    // the read and the write, and the gateway re-asks it anyway at the point of send),
                    // and it would need a second read seam into the messenger store for a question the
                    // gateway already owns. The cost is one card in the rare case the model sets
                    // `initiate` on a chat that turns out to have written to us — the field's own
                    // description tells it not to, and over-asking is the safe direction here.
                    if (initiating)
                      yield* permission.assert({
                        action: "messenger.initiate",
                        resources: [resource],
                        save: [resource],
                        sessionID: context.sessionID,
                        agent: context.agent,
                        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                      })
                    const outcome = yield* gateway.send({
                      accountID: resolved.account.id,
                      chatID,
                      text: input.text,
                      ...(initiating ? { initiate: true } : {}),
                      ...(input.reply === undefined || input.reply.trim().length === 0
                        ? {}
                        : { replyTo: input.reply.trim() }),
                    })
                    // Three arms, switched not truthiness-tested. `unavailable` carries through as
                    // itself: the model must not be told "the platform refused it" when the truth is
                    // that this instance could not check whether it was allowed to write at all.
                    if (outcome.kind === "refused")
                      return { outcome: "failed", message: outcome.reason } satisfies Output
                    if (outcome.kind === "unavailable")
                      return { outcome: "unavailable", message: outcome.reason } satisfies Output
                    return { outcome: "ok", message: "Sent (paced at human typing speed)." } satisfies Output
                  }
                  case "connect": {
                    const resolved = yield* resolveAccount(input.account)
                    if (resolved.account === undefined) return resolved.miss
                    // Bypass-bind warning (§3.4): wiring an UNTRUSTED client/audience chat into a
                    // session that auto-approves every tool call (bypass/yolo) hands a stranger an
                    // agent with no consent gate. Refuse unless the model confirms with the user and
                    // retries with force — the calm-warning pattern, not a hard block (the operator
                    // may genuinely want it, e.g. a curated-ruleset preset).
                    if (input.trust !== "operator" && input.force !== true) {
                      const effective = yield* resolveSessionConfig(
                        EFFECTIVE_CONFIG_DEFAULTS,
                        context.sessionID,
                        (id) => sessions.get(id as never),
                      ).pipe(Effect.orElseSucceed(() => EFFECTIVE_CONFIG_DEFAULTS))
                      const refusal = MessengerPipeline.bypassBindRefusal({
                        trust: input.trust,
                        permissionMode: effective.permissionMode,
                        force: false, // the outer guard already handled force:true
                      })
                      if (refusal !== undefined) return { outcome: "failed", message: refusal } satisfies Output
                    }
                    // Binding a chat to a session shapes where the agent listens — gated so a hostile
                    // client can't wire the agent into an arbitrary chat. Resource = the chat.
                    yield* permission.assert({
                      action: "messenger.connect",
                      resources: [`${resolved.account.id}:${input.chat.trim()}`],
                      save: ["*"],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    const binding = yield* store
                      .createBinding({
                        accountID: resolved.account.id,
                        chatID: input.chat.trim(),
                        sessionID: context.sessionID,
                        trust: input.trust,
                      })
                      .pipe(Effect.catch((error) => Effect.succeed({ error })))
                    if ("error" in binding)
                      return {
                        outcome: "failed",
                        message: `That chat is already bound to session ${binding.error.sessionID}. Disconnect it there first.`,
                      } satisfies Output
                    return {
                      outcome: "ok",
                      message: `Bound this session to chat ${input.chat.trim()} as "${input.trust}". Its incoming messages will now become your turns.`,
                    } satisfies Output
                  }
                  case "upload": {
                    if (gateway === undefined) return { outcome: "failed", message: OFFLINE_GATEWAY } satisfies Output
                    const resolved = yield* resolveAccount(input.account)
                    if (resolved.account === undefined) return resolved.miss
                    const caps = drivers.get(resolved.account.driverID)?.capabilities(resolved.account)
                    if (caps !== undefined && !caps.files.up)
                      return {
                        outcome: "failed",
                        message:
                          "This messenger can't carry files — paste the content as text or share a link instead.",
                      } satisfies Output
                    const filePath = yield* containedPath(input.path.trim())
                    if (filePath === undefined)
                      return {
                        outcome: "failed",
                        message:
                          "That path is outside this session's workspace — only workspace files can be uploaded.",
                      } satisfies Output
                    const stat = yield* Effect.tryPromise(() => fs.stat(filePath)).pipe(
                      Effect.orElseSucceed(() => undefined),
                    )
                    if (stat === undefined || !stat.isFile())
                      return { outcome: "failed", message: `No file at ${input.path.trim()}.` } satisfies Output
                    const maxBytes = caps?.files.maxBytes
                    if (maxBytes !== undefined && stat.size > maxBytes)
                      return {
                        outcome: "failed",
                        message: `That file is ${Math.round(stat.size / 1_000_000)} MB — this messenger caps uploads at ${Math.round(maxBytes / 1_000_000)} MB.`,
                      } satisfies Output
                    // Sending a file AS the user is a send — same gate, same resource shape.
                    yield* permission.assert({
                      action: "messenger.send",
                      resources: [`${resolved.account.id}:${input.chat.trim()}`],
                      save: ["*"],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    const data = yield* Effect.tryPromise(() => fs.readFile(filePath)).pipe(
                      Effect.mapError(() => new ToolFailure({ message: `Could not read ${input.path.trim()}.` })),
                    )
                    const outcome = yield* gateway.sendFile({
                      accountID: resolved.account.id,
                      chatID: input.chat.trim(),
                      file: {
                        name: path.basename(filePath),
                        mime: FSUtil.mimeType(filePath),
                        data: new Uint8Array(data),
                      },
                      ...(input.caption === undefined ? {} : { caption: input.caption }),
                    })
                    if (outcome.kind === "refused")
                      return { outcome: "failed", message: outcome.reason } satisfies Output
                    if (outcome.kind === "unavailable")
                      return { outcome: "unavailable", message: outcome.reason } satisfies Output
                    return {
                      outcome: "ok",
                      message: `Sent ${path.basename(filePath)} (${Math.max(1, Math.round(stat.size / 1024))} KB) to chat ${input.chat.trim()}.`,
                    } satisfies Output
                  }
                  case "download": {
                    if (gateway === undefined) return { outcome: "failed", message: OFFLINE_GATEWAY } satisfies Output
                    const scope = yield* readScope(context.sessionID)
                    if (scope === "unknown") return scopedReadRefusal(scope)!
                    const resolved = yield* resolveAccount(input.account, scopedAccounts(scope))
                    if (resolved.account === undefined) return resolved.miss
                    const refusal = scopedReadRefusal(scope, `${resolved.account.id}:${input.chat.trim()}`)
                    if (refusal !== undefined) return refusal
                    // Pulling remote data into the workspace moves the user's files around — the
                    // same messenger.send gate covers both directions (plan §4).
                    yield* permission.assert({
                      action: "messenger.send",
                      resources: [`${resolved.account.id}:${input.chat.trim()}`],
                      save: ["*"],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    const outcome = yield* gateway.attachment({
                      accountID: resolved.account.id,
                      chatID: input.chat.trim(),
                      messageID: input.message.trim(),
                    })
                    if (!outcome.ok) return { outcome: "failed", message: outcome.reason } satisfies Output
                    const relative = input.path?.trim().length
                      ? input.path.trim()
                      : path.join("downloads", outcome.name)
                    const target = yield* containedPath(relative)
                    if (target === undefined)
                      return {
                        outcome: "failed",
                        message: "That save path is outside this session's workspace — pick one inside it.",
                      } satisfies Output
                    yield* Effect.tryPromise(async () => {
                      await fs.mkdir(path.dirname(target), { recursive: true })
                      await fs.writeFile(target, outcome.data)
                    }).pipe(Effect.mapError(() => new ToolFailure({ message: `Could not write ${relative}.` })))
                    return {
                      outcome: "ok",
                      message: `Saved "${outcome.name}" (${outcome.mime}, ${Math.max(1, Math.round(outcome.data.byteLength / 1024))} KB) to ${relative}.`,
                    } satisfies Output
                  }
                  case "disconnect": {
                    const resolved = yield* resolveAccount(input.account)
                    if (resolved.account === undefined) return resolved.miss
                    // ⚠️ An empty list here used to mean "This session has no messenger binding to
                    // disconnect" — which the model relays as "you weren't connected". Said while the
                    // binding table is unreadable, that is a false statement about the session AND it
                    // leaves a live binding in place that the user now believes is gone.
                    const listed = yield* MessengerStore.attempted(store.bindingsForSession(context.sessionID))
                    if (!listed.read) return { outcome: "unavailable", message: STORE_UNAVAILABLE } satisfies Output
                    const bindings = listed.value
                    const target =
                      input.chat === undefined
                        ? (bindings.find((binding) => binding.accountID === resolved.account.id) ?? bindings[0])
                        : bindings.find((binding) => binding.chatID === input.chat!.trim())
                    if (target === undefined)
                      return {
                        outcome: "failed",
                        message: "This session has no messenger binding to disconnect.",
                      } satisfies Output
                    yield* store.removeBinding(target.id)
                    return {
                      outcome: "ok",
                      message: `Unbound this session from chat ${target.chatID}.`,
                    } satisfies Output
                  }
                  case "moderate": {
                    if (gateway === undefined) return { outcome: "failed", message: OFFLINE_GATEWAY } satisfies Output
                    const resolved = yield* resolveAccount(input.account)
                    if (resolved.account === undefined) return resolved.miss
                    const built = buildModerationAct(input)
                    if ("error" in built) return { outcome: "failed", message: built.error } satisfies Output
                    // Moderating a chat is consequential (deletes/bans act on other people) — gated like
                    // send, resource = the chat so rules can scope per conversation.
                    yield* permission.assert({
                      action: "messenger.moderate",
                      resources: [`${resolved.account.id}:${input.chat.trim()}`],
                      save: ["*"],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                    })
                    const outcome = yield* gateway.moderate({
                      accountID: resolved.account.id,
                      chatID: input.chat.trim(),
                      act: built,
                    })
                    if (!outcome.ok) return { outcome: "failed", message: outcome.reason } satisfies Output
                    return { outcome: "ok", message: `Done (${input.act}).` } satisfies Output
                  }
                }
              }).pipe(
                // A denied/asked-and-refused `messenger.send` reads as a denial, not a crash;
                // anything else unexpected is a real infra fault (bash.ts precedent).
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({
                    message: `messenger failed: ${error instanceof Error ? error.message : String(error)}`,
                  })
                }),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/messenger",
  layer,
  deps: [
    ToolRegistry.node,
    MessengerStore.node,
    MessengerDrivers.node,
    PermissionV2.node,
    Location.node,
    LocationMutation.node,
    SessionStore.node,
  ],
})
