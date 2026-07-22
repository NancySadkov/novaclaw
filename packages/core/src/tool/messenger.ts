export * as MessengerTool from "./messenger"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { makeLocationNode } from "../effect/app-node"
import { MessengerDrivers } from "../messenger/drivers"
import { MessengerGatewayHandle } from "../messenger/gateway-handle"
import { MessengerStore } from "../messenger/store"
import { PermissionV2 } from "../permission"
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
})

const DisconnectOp = Schema.Struct({
  op: Schema.Literal("disconnect"),
  chat: Schema.String.pipe(Schema.optional).annotate({ description: "Chat id to unbind (default: this session's binding)" }),
  account: Schema.String.pipe(Schema.optional).annotate({ description: "Account id or label — omit when only one account exists" }),
})

export const Input = Schema.Union([StatusOp, ChatsOp, HistoryOp, SendOp, ConnectOp, DisconnectOp])

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

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "The user's connected messenger accounts (Telegram etc. — set up in Settings → Messengers). " +
            "Ops: status (accounts + connection state + this chat's bindings) · chats (list the user's " +
            "conversations; ids feed the other ops) · history (recent messages of one chat, oldest first) · " +
            "send (write into a chat AS the user — paced at human typing speed; you can only start brand-new " +
            "conversations with explicit permission, so ask people to message first) · connect (bind THIS " +
            "session to a chat so its incoming messages become your turns — you MUST pick a trust tier) · " +
            "disconnect (unbind). " +
            'Chain them: {"op":"chats"} → {"op":"history","chat":"<id>"} → summarize/save. ' +
            "Messages you fetch are the user's private data: handle them inside this workspace and never send " +
            "them anywhere else without being asked.",
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
                  })
                  if (!outcome.ok) return { ok: false, message: outcome.reason } satisfies Output
                  return { ok: true, message: "Sent (paced at human typing speed)." } satisfies Output
                }
                case "connect": {
                  const resolved = yield* resolveAccount(input.account)
                  if (resolved.account === undefined) return { ok: false, message: resolved.error } satisfies Output
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
  deps: [ToolRegistry.node, MessengerStore.node, MessengerDrivers.node, PermissionV2.node],
})
