export * as MessengerTool from "./messenger"

import fs from "node:fs/promises"
import path from "node:path"
import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import type { ModerationAct } from "../messenger/driver"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { MessengerDrivers } from "../messenger/drivers"
import { MessengerGatewayHandle } from "../messenger/gateway-handle"
import { MessengerPipeline } from "../messenger/pipeline"
import { MessengerStore } from "../messenger/store"
import { PermissionV2 } from "../permission"
import { EFFECTIVE_CONFIG_DEFAULTS, resolveSessionConfig } from "../session/config-resolve"
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
})

const SendOp = Schema.Struct({
  op: Schema.Literal("send"),
  chat: Schema.String.annotate({ description: "Chat id (from `chats`) to write into" }),
  text: Schema.String.annotate({ description: "The message text — sent AS the user, paced at human typing speed" }),
  reply: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Message id this answers (from the `msg …` in a message header, or from history) — attaches the reply to that message. Use it in busy group chats so people can tell what you're answering.",
  }),
  account: Schema.String.pipe(Schema.optional).annotate({
    description: "Account id (msa_…) or label — omit when only one account exists",
  }),
})

const ConnectOp = Schema.Struct({
  op: Schema.Literal("connect"),
  chat: Schema.String.annotate({ description: "Chat id (from `chats`) to bind THIS session to — inbound messages become your turns" }),
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
  chat: Schema.String.pipe(Schema.optional).annotate({ description: "Chat id to unbind (default: this session's binding)" }),
  account: Schema.String.pipe(Schema.optional).annotate({ description: "Account id or label — omit when only one account exists" }),
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
  message: Schema.String.annotate({ description: "Message id carrying the attachment (shown in message headers and history)" }),
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
  message: Schema.String.pipe(Schema.optional).annotate({ description: "Message id — required for delete, pin and approve" }),
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

export const Input = Schema.Union([StatusOp, ChatsOp, HistoryOp, SendOp, ConnectOp, DisconnectOp, UploadOp, DownloadOp, ModerateOp])

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
      return message ? { act: "delete", messageID: message } : { error: "delete needs a message id (from history/chat headers)." }
    case "pin":
      return message ? { act: "pin", messageID: message } : { error: "pin needs a message id." }
    case "approve":
      return message ? { act: "approve", messageID: message } : { error: "approve needs the message id of the item to restore." }
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
        ? { act: "mute", userID: user, ...(input.seconds === undefined ? {} : { seconds: Math.max(1, Math.floor(input.seconds)) }) }
        : { error: "mute needs a user id." }
  }
}

const Output = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
})
type Output = typeof Output.Type

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

export const formatChats = (chats: ReadonlyArray<Messenger.ChatInfo>): string =>
  chats.map((chat) => `${chat.chatID} · [${chat.kind}] ${oneLine(chat.title)}`).join("\n")

export const formatHistory = (messages: ReadonlyArray<{ senderName: string; outgoing: boolean; text?: string; at: number }>): string =>
  messages
    .map((message) => {
      const when = new Date(message.at).toISOString().slice(0, 16).replace("T", " ")
      const who = message.outgoing ? "me" : oneLine(message.senderName)
      return `${when} ${who}: ${message.text === undefined ? "(no text)" : oneLine(message.text)}`
    })
    .join("\n")

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

    type Resolved =
      | { readonly error: string; readonly account?: undefined }
      | { readonly error?: undefined; readonly account: Messenger.AccountInfo }

    // Resolve the account by id, label, or driver id — or the sole account when unambiguous.
    const resolveAccount = (selector: string | undefined): Effect.Effect<Resolved> =>
      Effect.gen(function* () {
        const accounts = yield* store.listAccounts().pipe(Effect.orElseSucceed(() => []))
        if (accounts.length === 0)
          return { error: "No messenger accounts are set up. Ask the user to add one in Settings → Messengers." }
        if (selector === undefined) {
          if (accounts.length === 1) return { account: accounts[0]! }
          return {
            error:
              `Several accounts exist — name one: ` +
              accounts.map((account) => `${account.id} (${account.label})`).join(", "),
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
            error:
              `No account matches "${selector}". Known: ` +
              accounts.map((account) => `${account.id} (${account.label})`).join(", "),
          }
        return { account: match }
      })

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
      const target = yield* mutation
        .resolve({ path: raw, kind: "file" })
        .pipe(Effect.orElseSucceed(() => undefined))
      if (target === undefined || target.externalDirectory !== undefined) return undefined
      return target.canonical
    })

    yield* tools
      .register({
        [name]: Tool.make({
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
            "user, paced at human speed; starting a brand-new conversation needs explicit permission, so ask " +
            "people to message first) · connect (bind THIS session to a chat/thread — pick a trust tier) · " +
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
            '⚠️ For RESEARCH read BROADCAST chats only: kind "channel", plus a "thread"/"topic" inside one. ' +
            'A "dm", "group" or "mailbox" is the user\'s private correspondence — never pull it into research ' +
            "output and never cite it as a source.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const gateway = MessengerGatewayHandle.get()
              switch (input.op) {
                case "status": {
                  const accounts = yield* store.listAccounts().pipe(Effect.orElseSucceed(() => []))
                  if (accounts.length === 0)
                    return {
                      ok: false,
                      message: "No messenger accounts are set up. Ask the user to add one in Settings → Messengers.",
                    } satisfies Output
                  const status =
                    gateway === undefined
                      ? new Map<Messenger.AccountID, Messenger.AccountStatus>()
                      : yield* gateway.status()
                  const bindings = yield* store
                    .bindingsForSession(context.sessionID)
                    .pipe(Effect.orElseSucceed(() => []))
                  const lines = accounts.map((account) => {
                    const driver = drivers.get(account.driverID)
                    const state = status.get(account.id)
                    return `${account.id} · ${account.label} (${driver?.meta.name ?? account.driverID}) · ${state === undefined ? "off" : statusLine(state)}`
                  })
                  const bound =
                    bindings.length === 0
                      ? "This chat has no remote binding."
                      : bindings.map((binding) => `This chat is bound to chat ${binding.chatID} on ${binding.accountID} (${binding.trust}).`).join("\n")
                  return { ok: true, message: `${lines.join("\n")}\n${bound}` } satisfies Output
                }
                case "chats": {
                  if (gateway === undefined) return { ok: false, message: OFFLINE_GATEWAY } satisfies Output
                  const resolved = yield* resolveAccount(input.account)
                  if (resolved.account === undefined) return { ok: false, message: resolved.error } satisfies Output
                  const outcome = yield* gateway.chats(resolved.account.id)
                  if (!outcome.ok) return { ok: false, message: outcome.reason } satisfies Output
                  if (outcome.chats.length === 0)
                    return { ok: false, message: "No chats are visible on that account yet." } satisfies Output
                  return {
                    ok: true,
                    message: formatChats([...outcome.chats]),
                  } satisfies Output
                }
                case "history": {
                  if (gateway === undefined) return { ok: false, message: OFFLINE_GATEWAY } satisfies Output
                  const resolved = yield* resolveAccount(input.account)
                  if (resolved.account === undefined) return { ok: false, message: resolved.error } satisfies Output
                  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)))
                  const outcome = yield* gateway.history({
                    accountID: resolved.account.id,
                    chatID: input.chat.trim(),
                    limit,
                  })
                  if (!outcome.ok) return { ok: false, message: outcome.reason } satisfies Output
                  if (outcome.messages.length === 0)
                    return { ok: false, message: "That chat has no fetchable messages." } satisfies Output
                  return { ok: true, message: formatHistory([...outcome.messages]) } satisfies Output
                }
                case "send": {
                  if (gateway === undefined) return { ok: false, message: OFFLINE_GATEWAY } satisfies Output
                  const resolved = yield* resolveAccount(input.account)
                  if (resolved.account === undefined) return { ok: false, message: resolved.error } satisfies Output
                  // Writing AS the user is consequential — permission-gated (default policy applies;
                  // the resource is the chat so saved rules can scope per conversation).
                  yield* permission.assert({
                    action: "messenger.send",
                    resources: [`${resolved.account.id}:${input.chat.trim()}`],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  const outcome = yield* gateway.send({
                    accountID: resolved.account.id,
                    chatID: input.chat.trim(),
                    text: input.text,
                    ...(input.reply === undefined || input.reply.trim().length === 0 ? {} : { replyTo: input.reply.trim() }),
                  })
                  if (!outcome.ok) return { ok: false, message: outcome.reason } satisfies Output
                  return { ok: true, message: "Sent (paced at human typing speed)." } satisfies Output
                }
                case "connect": {
                  const resolved = yield* resolveAccount(input.account)
                  if (resolved.account === undefined) return { ok: false, message: resolved.error } satisfies Output
                  // Bypass-bind warning (§3.4): wiring an UNTRUSTED client/audience chat into a
                  // session that auto-approves every tool call (bypass/yolo) hands a stranger an
                  // agent with no consent gate. Refuse unless the model confirms with the user and
                  // retries with force — the calm-warning pattern, not a hard block (the operator
                  // may genuinely want it, e.g. a curated-ruleset preset).
                  if (input.trust !== "operator" && input.force !== true) {
                    const effective = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, context.sessionID, (id) =>
                      sessions.get(id as never),
                    ).pipe(Effect.orElseSucceed(() => EFFECTIVE_CONFIG_DEFAULTS))
                    const refusal = MessengerPipeline.bypassBindRefusal({
                      trust: input.trust,
                      permissionMode: effective.permissionMode,
                      force: false, // the outer guard already handled force:true
                    })
                    if (refusal !== undefined) return { ok: false, message: refusal } satisfies Output
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
                      ok: false,
                      message: `That chat is already bound to session ${binding.error.sessionID}. Disconnect it there first.`,
                    } satisfies Output
                  return {
                    ok: true,
                    message: `Bound this session to chat ${input.chat.trim()} as "${input.trust}". Its incoming messages will now become your turns.`,
                  } satisfies Output
                }
                case "upload": {
                  if (gateway === undefined) return { ok: false, message: OFFLINE_GATEWAY } satisfies Output
                  const resolved = yield* resolveAccount(input.account)
                  if (resolved.account === undefined) return { ok: false, message: resolved.error } satisfies Output
                  const caps = drivers.get(resolved.account.driverID)?.capabilities(resolved.account)
                  if (caps !== undefined && !caps.files.up)
                    return {
                      ok: false,
                      message: "This messenger can't carry files — paste the content as text or share a link instead.",
                    } satisfies Output
                  const filePath = yield* containedPath(input.path.trim())
                  if (filePath === undefined)
                    return {
                      ok: false,
                      message: "That path is outside this session's workspace — only workspace files can be uploaded.",
                    } satisfies Output
                  const stat = yield* Effect.tryPromise(() => fs.stat(filePath)).pipe(
                    Effect.orElseSucceed(() => undefined),
                  )
                  if (stat === undefined || !stat.isFile())
                    return { ok: false, message: `No file at ${input.path.trim()}.` } satisfies Output
                  const maxBytes = caps?.files.maxBytes
                  if (maxBytes !== undefined && stat.size > maxBytes)
                    return {
                      ok: false,
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
                  if (!outcome.ok) return { ok: false, message: outcome.reason } satisfies Output
                  return {
                    ok: true,
                    message: `Sent ${path.basename(filePath)} (${Math.max(1, Math.round(stat.size / 1024))} KB) to chat ${input.chat.trim()}.`,
                  } satisfies Output
                }
                case "download": {
                  if (gateway === undefined) return { ok: false, message: OFFLINE_GATEWAY } satisfies Output
                  const resolved = yield* resolveAccount(input.account)
                  if (resolved.account === undefined) return { ok: false, message: resolved.error } satisfies Output
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
                  if (!outcome.ok) return { ok: false, message: outcome.reason } satisfies Output
                  const relative = input.path?.trim().length ? input.path.trim() : path.join("downloads", outcome.name)
                  const target = yield* containedPath(relative)
                  if (target === undefined)
                    return {
                      ok: false,
                      message: "That save path is outside this session's workspace — pick one inside it.",
                    } satisfies Output
                  yield* Effect.tryPromise(async () => {
                    await fs.mkdir(path.dirname(target), { recursive: true })
                    await fs.writeFile(target, outcome.data)
                  }).pipe(Effect.mapError(() => new ToolFailure({ message: `Could not write ${relative}.` })))
                  return {
                    ok: true,
                    message: `Saved "${outcome.name}" (${outcome.mime}, ${Math.max(1, Math.round(outcome.data.byteLength / 1024))} KB) to ${relative}.`,
                  } satisfies Output
                }
                case "disconnect": {
                  const resolved = yield* resolveAccount(input.account)
                  if (resolved.account === undefined) return { ok: false, message: resolved.error } satisfies Output
                  const bindings = yield* store.bindingsForSession(context.sessionID).pipe(Effect.orElseSucceed(() => []))
                  const target =
                    input.chat === undefined
                      ? bindings.find((binding) => binding.accountID === resolved.account.id) ?? bindings[0]
                      : bindings.find((binding) => binding.chatID === input.chat!.trim())
                  if (target === undefined)
                    return { ok: false, message: "This session has no messenger binding to disconnect." } satisfies Output
                  yield* store.removeBinding(target.id)
                  return { ok: true, message: `Unbound this session from chat ${target.chatID}.` } satisfies Output
                }
                case "moderate": {
                  if (gateway === undefined) return { ok: false, message: OFFLINE_GATEWAY } satisfies Output
                  const resolved = yield* resolveAccount(input.account)
                  if (resolved.account === undefined) return { ok: false, message: resolved.error } satisfies Output
                  const built = buildModerationAct(input)
                  if ("error" in built) return { ok: false, message: built.error } satisfies Output
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
                  if (!outcome.ok) return { ok: false, message: outcome.reason } satisfies Output
                  return { ok: true, message: `Done (${input.act}).` } satisfies Output
                }
              }
            }).pipe(
              // A denied/asked-and-refused `messenger.send` reads as a denial, not a crash;
              // anything else unexpected is a real infra fault (bash.ts precedent).
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                return new ToolFailure({ message: `messenger failed: ${error instanceof Error ? error.message : String(error)}` })
              }),
            ),
        }),
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
