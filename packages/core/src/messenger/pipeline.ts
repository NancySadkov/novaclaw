export * as MessengerPipeline from "./pipeline"

import type { Messenger } from "@novaclaw/schema/messenger"
import type { Origin } from "@novaclaw/schema/prompt"
import type { InboundEvent } from "./driver"

// Pure helpers for the gateway's inbound/outbound pipeline (notes/messenger-plan.md §3.2) —
// separated so the provenance framing and command rendering are unit-testable without a live
// gateway. The effectful routing (SessionV2.prompt, driver.send) lives in gateway.ts.

/** A stable key for one remote chat (an account + its chat id). */
export const chatKey = (accountID: Messenger.AccountID, chatID: string): string => `${accountID}:${chatID}`

/** Build the structured provenance (Prompt.origin, P6) for an inbound remote message — the ONE
 *  place a driver event becomes a kernel Origin. The runner renders the model header + untrusted-
 *  input framing from this (session/origin.ts); the driver no longer hand-builds header text.
 *  `body` overrides the event text (materialized-attachment notes fold in there). */
export const origin = (
  event: Extract<InboundEvent, { kind: "message" }>,
  driverID: string,
  accountID: string,
  trust: Messenger.Trust,
): Origin =>
  ({
    via: "messenger",
    driver: driverID,
    accountID,
    chatID: event.chat.chatID,
    chatKind: event.chat.kind,
    ...(event.chat.title === undefined ? {} : { chatTitle: event.chat.title }),
    senderID: event.sender.id,
    senderName: event.sender.name,
    messageID: event.messageID,
    ...(event.replyTo === undefined ? {} : { replyTo: event.replyTo }),
    trust,
    at: event.at,
  }) satisfies Origin

/** Render `/sessions`. Returns the reply text AND the ordered ids so `/use N` can index the same
 *  list the operator just saw (cached per chat by the gateway — no index drift). */
export const renderSessions = (
  sessions: ReadonlyArray<{ readonly id: string; readonly title?: string; readonly agent?: string }>,
): { text: string; ids: string[] } => {
  if (sessions.length === 0)
    return { text: "No sessions yet. Create one in the NovaClaw app, then /use its number here.", ids: [] }
  const shown = sessions.slice(0, 20)
  const lines = shown.map((session, index) => {
    const label = session.title?.trim() || session.id
    const agent = session.agent ? ` · ${session.agent}` : ""
    return `${index + 1}. ${label}${agent}`
  })
  return {
    text: `Your sessions:\n${lines.join("\n")}\n\nReply /use <number> to drive one from here.`,
    ids: shown.map((session) => session.id),
  }
}

/** The default agent address in the self-chat console (§0.1.5) — the product name; a per-account
 *  `address` setting overrides it ("whatever name the user picked for the agent"). */
export const DEFAULT_ADDRESS = "Nova"

const escapeRegex = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** §0.1.5 — the self-chat address gate. Operator and agent share one pen in Saved Messages, so
 *  only messages addressed to the agent ("Nova, do X" / "nova: do X") are commands; everything
 *  else is the user's own notes and must be IGNORED. Returns the prompt with the address stripped,
 *  or undefined when the message is not addressed to the agent. Gateway `/commands` never reach
 *  this ("/" is already an address). */
export const addressed = (text: string, address: string): string | undefined => {
  const name = address.trim() || DEFAULT_ADDRESS
  const match = text.match(new RegExp(`^\\s*${escapeRegex(name)}\\s*[,:]\\s*`, "i"))
  if (match === null) return undefined
  const prompt = text.slice(match[0].length).trim()
  return prompt.length > 0 ? prompt : undefined
}

// ── the self-chat dispatcher (§0.1.5 rule 3 — spawn, don't inline) ─────────────────────────────
// The console session never takes a turn: each `Nova, …` prompt becomes a CHILD session, and the
// child carries a DISPATCH TARGET in its session metadata — the chat its progress and exit result
// report back to. Metadata, deliberately NOT a binding row: a dispatched task must not behave like
// a bound chat (no inbound routing, no steal-protected UNIQUE(chat) slot — many tasks, one chat).

/** The session-metadata key a console dispatch stamps on the child it spawns. */
export const DISPATCH_KEY = "messengerDispatch"

export interface DispatchTarget {
  readonly accountID: string
  readonly chatID: string
}

export const dispatchMetadata = (target: DispatchTarget): Record<string, unknown> => ({
  [DISPATCH_KEY]: { accountID: target.accountID, chatID: target.chatID },
})

/** Read a dispatch target back off session metadata; undefined when absent or malformed. */
export const dispatchTarget = (
  metadata: { readonly [key: string]: unknown } | undefined,
): DispatchTarget | undefined => {
  const raw = metadata?.[DISPATCH_KEY]
  if (typeof raw !== "object" || raw === null) return undefined
  const { accountID, chatID } = raw as { readonly [key: string]: unknown }
  return typeof accountID === "string" && typeof chatID === "string" ? { accountID, chatID } : undefined
}

/** The dispatched child's title — the task itself, flattened + truncated so ps/Chats read well.
 *  A custom title also keeps auto-title off (SessionTitle.isDefault fails), which is right: the
 *  task IS the best name for a task session. */
export const dispatchTitle = (task: string): string => {
  const flat = task.replaceAll(/\s+/g, " ").trim()
  return flat.length <= 64 ? flat : `${flat.slice(0, 63).trimEnd()}…`
}

/** The console's dispatch acknowledgement — short, because the pacer types it like a human. */
export const DISPATCH_ACK = "🚀 On it — I'll report back here when it's done."

/** How long a dispatched task may run before it is worth saying "on it" at all. An answer that
 *  beats this never gets an ack: telling someone you have started, and then finishing one message
 *  later, costs them two notifications to learn one thing. */
export const DISPATCH_ACK_DELAY_MS = 6_000

/** Does a finished task's result tell the operator anything they have not already read?
 *
 *  A dispatched task narrates as it works (every finished assistant text relays to the chat) and
 *  then reports its `exit(result)`. For real work those differ and both earn their place. For a
 *  QUESTION — the common case on a phone — the answer already went out as narration and the report
 *  is the same thing said twice, in worse words: live, "It's Thursday, July 23, 2026" was followed
 *  by "✅ Answered user's question about current time: Thursday, July 23, 2026".
 *
 *  Wording alone can't catch that (a paraphrase isn't a substring), so the real signal is `didWork`:
 *  whether the task called any tool other than `exit`. A task that only talked has already
 *  delivered everything it has; a task that edited files or ran commands owes a summary of what it
 *  did. Silence is the one failure worse than repetition, so a task that never narrated always
 *  reports — even with an empty result. */
export const dispatchDoneNeeded = (result: string, lastRelayed: string | undefined, didWork: boolean): boolean => {
  const flat = (text: string) => text.replaceAll(/\s+/g, " ").trim()
  const body = flat(result)
  const seen = lastRelayed === undefined ? undefined : flat(lastRelayed)
  if (seen === undefined) return true // nothing reached the operator yet — always report
  if (!didWork) return false // it only talked, and the operator already read what it said
  if (body.length === 0) return false
  // Equal, or the result merely restates a slice of what was already said.
  return body !== seen && !seen.includes(body)
}

/** How long a dispatched task's narration waits before it is relayed to the operator's chat.
 *
 *  The last thing an agent says before calling `exit` is a sign-off ("already answered — no further
 *  action needed"), and the completion report says the same thing better. Nothing on the text event
 *  marks it as final, but the exit lands a beat later — so holding each narration briefly and
 *  dropping it if the task has meanwhile ended removes the sign-off without needing a new signal.
 *  Ordinary progress lines are unaffected: they are followed by more work, not by an exit, and a
 *  couple of seconds is invisible next to the human-paced typing they are queued behind. */
export const NARRATION_SETTLE_MS = 2_500

/** The completion report for a dispatched task: the child's exit(result), relayed to the chat
 *  that asked. The title identifies WHICH task finished (several may run at once). */
export const renderDispatchDone = (title: string | undefined, result: string): string => {
  const head = title === undefined || title.trim().length === 0 ? "✅ Task finished" : `✅ ${title.trim()}`
  const body = result.trim()
  return body.length === 0 ? head : `${head}\n${body}`
}

// The bypass-bind warning (§3.4), as a pure decision so it's unit-testable away from the tool
// graph. Wiring an UNTRUSTED client/audience chat into a session that auto-approves every tool
// call (bypass/yolo) hands a stranger an agent with no consent gate — refuse unless the caller
// confirmed and forced. operator trust (the owner/family) is exempt; `force` overrides. Returns
// the refusal text, or undefined when the bind is allowed.
export const bypassBindRefusal = (input: {
  readonly trust: Messenger.Trust
  readonly permissionMode: string
  readonly force: boolean
}): string | undefined => {
  if (input.trust === "operator" || input.force) return undefined
  if (input.permissionMode !== "bypass" && input.permissionMode !== "yolo") return undefined
  return (
    `This session is in "${input.permissionMode}" permission mode — it auto-approves every tool call. ` +
    `Binding an untrusted ${input.trust} chat to it means a stranger's messages drive an agent with no consent gate. ` +
    `Confirm with the user that this is intended (ideally switch to a curated agent preset first), then retry with force:true.`
  )
}

export const HELP_TEXT = [
  "NovaClaw remote control:",
  "/sessions — list your chats",
  "/use <n> — drive session n from here",
  "/status — this chat's link",
  "/pair <code> — pair this chat (code from Settings → Messengers)",
  "/help — this message",
].join("\n")

/** The canned reply for an unpaired sender (default is silence; a per-account setting may enable
 *  this). Kept here so its wording is testable and consistent. */
export const UNPAIRED_HINT =
  "This account isn't set up to chat with you. If you're the operator, pair from Settings → Messengers and send /pair <code>."
