export * as RedditDriver from "./reddit"

import { Deferred, Duration, Effect, Queue, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import type {
  ChatSnapshot,
  Connection,
  ConnectContext,
  Driver,
  HistoryEntry,
  InboundEvent,
  LoginPending,
  LoginSupport,
  ModerationAct,
  OutboundMessage,
} from "../driver"
import { ChallengeError, ConnectError, LoginCodeError, ModerationError, SendError } from "../driver"
import type { LoopbackFactory } from "../oauth-loopback"
import { InstallationVersion } from "../../installation/version"

// The Reddit driver (messenger-plan §2.1) — a SUBREDDIT is the chat you bind, and every post inside
// it is a thread whose parent is the subreddit. That shape is the whole reason one binding can
// moderate a live community: posts appear continuously, so binding each one is impossible, and the
// gateway's parent fallback (ChatSnapshot.parentID) routes every post and comment to the subreddit's
// session while replies still land in the right thread.
//
// Auth is an INSTALLED app (no client secret to leak in a distributed desktop binary) + the
// auth-code loopback flow we already use for Gmail, with `duration=permanent` for a refresh token.
// The client id is a per-user SETTING on purpose: Reddit's 100 QPM limit is per OAuth client id, so
// one id baked into the binary would put every NovaClaw user in one shared bucket.
//
// ⚠️ Reddit gates Data API access behind an approval ticket, and steers moderation tooling to
// Devvit — which executes on Reddit's servers and therefore cannot host a local-first agent. This
// driver is the Data API path; it needs the operator's own approved app.

const WWW = "https://www.reddit.com"
const OAUTH = "https://oauth.reddit.com"

// ⚠️ Reddit matches the OAuth redirect URI EXACTLY (unlike Google, which ignores the loopback
// port for Desktop clients). So the port is FIXED and the URI is a single constant the user must
// register verbatim — the setup recipe below tells them this exact string. Change one, change both.
export const LOOPBACK_PORT = 8080
export const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}`

// Everything this driver actually calls, and nothing more (Reddit's grant is moderation-scoped).
export const SCOPES = "identity read submit privatemessages modposts modcontributors modmail modlog edit"

const CAPS: Messenger.Capabilities = {
  listChats: "full", // the subreddit + its live posts
  files: { up: false, down: false },
  edits: false,
  typing: false,
  threads: true,
  moderation: { delete: true, ban: true, kick: false, mute: true, pin: true, approve: true, lock: true },
  format: "markdown",
  maxChars: 10_000,
}

/** A page of listing children, already narrowed to the fields we read. */
interface Thing {
  readonly kind: string
  readonly data: Record<string, unknown>
}

export interface RedditConfig {
  readonly subreddit: string
  readonly clientId: string
  /** The bot account's username — REQUIRED contact info in Reddit's User-Agent rule. */
  readonly username: string
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** The stored credential: Reddit's refresh token is the durable identity (access tokens last 1h). */
export interface StoredCredential {
  readonly refreshToken: string
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────────────────────────

/** Reddit REQUIRES `<platform>:<app id>:<version> (by /u/<user>)` and drastically limits generic
 *  agents. Lying about it is also a terms violation, so this is the only agent we ever send. */
export const userAgent = (username: string, version: string): string =>
  `novaclaw:app.novaclaw.messenger:v${version} (by /u/${username.replace(/^\/?u\//, "")})`

/** `r/name` → `name`, tolerating what a user actually types (`/r/NovaClaw/`, a full URL). */
export const normalizeSubreddit = (raw: string): string =>
  raw
    .trim()
    .replace(/^https?:\/\/(www\.)?reddit\.com/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^r\//i, "")

/** The chat id for a subreddit — prefixed so it can never collide with a `t3_…` post thread. */
export const subredditChatID = (subreddit: string): string => `r/${subreddit}`

/**
 * The modqueue as a CHAT. Reported and spam-filtered items are the actual job of moderating a
 * subreddit, and they do not show up in `/new`: a report can land on a week-old comment. Rather
 * than invent a tool op nothing else has, the queue is a conversation the agent can read with
 * `history` and that pushes an item when something arrives — parented to the subreddit, so the
 * ONE binding already covers it.
 */
export const modqueueChatID = (subreddit: string): string => `r/${subreddit}/modqueue`

export const isModqueueChat = (chatID: string): boolean => chatID.endsWith("/modqueue")

/** Why this item is sitting in the queue, in the words a moderator would use. */
export const queueReason = (data: Record<string, unknown>): string => {
  const reports = typeof data["num_reports"] === "number" ? data["num_reports"] : 0
  const bannedBy = data["banned_by"]
  const parts: string[] = []
  if (reports > 0) parts.push(`${reports} report${reports === 1 ? "" : "s"}`)
  // `banned_by` is Reddit's field for "removed by", and the literal `true` means its spam filter.
  if (bannedBy === true) parts.push("caught by the spam filter")
  else if (typeof bannedBy === "string" && bannedBy.length > 0) parts.push(`removed by ${bannedBy}`)
  const userReports = Array.isArray(data["user_reports"]) ? data["user_reports"] : []
  const reasons = userReports
    .map((entry) => (Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined))
    .filter((reason): reason is string => reason !== undefined)
  if (reasons.length > 0) parts.push(`reported as: ${reasons.slice(0, 3).join(", ")}`)
  return parts.length === 0 ? "awaiting review" : parts.join(" · ")
}

export const isPostChat = (chatID: string): boolean => chatID.startsWith("t3_")

/** Reddit ids are `<type>_<base36>`; some endpoints want the bare base36 ("article"), and mixing
 *  the two up is the classic Reddit integration bug. */
export const bareID = (fullname: string): string => (fullname.includes("_") ? fullname.slice(fullname.indexOf("_") + 1) : fullname)

/** Reddit answers a throttled WRITE with HTTP 200 and the error inside the body, so a driver that
 *  only checks status codes silently drops replies. Returns the retry delay when that happened. */
export const parseRateLimit = (body: unknown): { readonly retryAfterMs: number } | undefined => {
  const errors = (body as { json?: { errors?: unknown } })?.json?.errors
  if (!Array.isArray(errors)) return undefined
  for (const entry of errors) {
    if (!Array.isArray(entry) || entry[0] !== "RATELIMIT") continue
    const message = typeof entry[1] === "string" ? entry[1] : ""
    const match = /([0-9]{1,3})\s+(millisecond|second|minute)s?/i.exec(message)
    if (match === undefined || match === null) return { retryAfterMs: 60_000 }
    const amount = Number(match[1])
    const unit = match[2]!.toLowerCase()
    return { retryAfterMs: unit === "millisecond" ? amount : unit === "second" ? amount * 1000 : amount * 60_000 }
  }
  return undefined
}

/** The first API error string, if the body carries one (Reddit's `json.errors` envelope). */
export const parseApiError = (body: unknown): string | undefined => {
  const errors = (body as { json?: { errors?: unknown } })?.json?.errors
  if (!Array.isArray(errors) || errors.length === 0) return undefined
  const first = errors[0]
  if (!Array.isArray(first)) return typeof first === "string" ? first : "Reddit refused the request"
  return [first[0], first[1]].filter((part): part is string => typeof part === "string").join(": ")
}

/** Where each moderation act goes. Pure so the whole mapping is unit-testable without a socket —
 *  Reddit spreads it over five endpoints with different shapes. `undefined` = this driver can't. */
export const moderationRequest = (
  subreddit: string,
  chatID: string,
  act: ModerationAct,
): { readonly path: string; readonly form: Record<string, string> } | { readonly refusal: string } => {
  switch (act.act) {
    case "delete":
      // `spam:false` = an ordinary removal; the spam flag is for training the filter, which is not
      // what "delete this message" means.
      return { path: "/api/remove", form: { id: act.messageID, spam: "false" } }
    case "approve":
      return { path: "/api/approve", form: { id: act.messageID } }
    case "ban":
      // Reddit CANNOT delete a banned user's back catalogue as part of the ban — say so instead of
      // banning them and quietly leaving the spam up, which reads as success.
      if (act.purgeSeconds !== undefined)
        return { refusal: "Reddit can't remove a user's past posts as part of a ban — ban them, then remove the items (they're in the queue)." }
      return {
        path: `/r/${subreddit}/api/friend`,
        form: {
          type: "banned",
          name: act.userID,
          api_type: "json",
          ...(act.durationDays === undefined ? {} : { duration: String(Math.max(1, Math.min(999, Math.round(act.durationDays)))) }),
        },
      }
    case "mute":
      // Reddit's mute is modmail-scoped and takes no duration here — `seconds` is silently N/A
      // rather than a refusal, because muting IS the action the caller asked for.
      return { path: `/r/${subreddit}/api/friend`, form: { type: "muted", name: act.userID, api_type: "json" } }
    case "pin":
      // A post gets stickied to the subreddit; a comment gets distinguished-and-stickied to the top
      // of its thread (Reddit's two different "pin"s).
      return isPostChat(act.messageID)
        ? { path: "/api/set_subreddit_sticky", form: { id: act.messageID, state: "true", num: "1", api_type: "json" } }
        : { path: "/api/distinguish", form: { id: act.messageID, how: "yes", sticky: "true", api_type: "json" } }
    case "lock":
      return isPostChat(chatID)
        ? { path: "/api/lock", form: { id: chatID } }
        : { refusal: "Only a post can be locked — name the post's chat, not the subreddit." }
    case "kick":
      return { refusal: "Reddit has no kick — ban the user instead (a ban can be temporary)." }
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)

/** A post → the chat it opens plus the message that opened it. Title and body are one message: to a
 *  reader they ARE the post, and an agent triaging bug reports needs both. */
export const postInbound = (subreddit: string, data: Record<string, unknown>, selfName: string | undefined): InboundEvent | undefined => {
  const name = str(data["name"]) ?? (str(data["id"]) === undefined ? undefined : `t3_${str(data["id"])}`)
  const author = str(data["author"])
  if (name === undefined || author === undefined) return undefined
  const title = str(data["title"]) ?? "(untitled)"
  const body = str(data["selftext"]) ?? ""
  const link = str(data["url"])
  const text = [title, body.length > 0 ? body : undefined, body.length === 0 && link ? link : undefined]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n")
  return {
    kind: "message",
    chat: { chatID: name, kind: "thread", title, parentID: subredditChatID(subreddit) },
    messageID: name,
    // The id IS the username: Reddit moderation acts on names, not on t2_ ids, so this is what
    // `moderate ban` needs to receive from the message header.
    sender: { id: author, name: author, isSelf: selfName !== undefined && author.toLowerCase() === selfName.toLowerCase() },
    text,
    at: (num(data["created_utc"]) ?? Date.now() / 1000) * 1000,
  }
}

/**
 * A queued item as a message in the modqueue chat. It carries the SAME fullname as the item itself,
 * so the id the agent reads here is exactly the id `moderate approve|delete` takes — and because it
 * lands in the queue chat rather than the post's thread, an item that was already delivered when it
 * was posted doesn't read as a duplicate of itself.
 */
export const modqueueInbound = (subreddit: string, data: Record<string, unknown>, selfName: string | undefined): InboundEvent | undefined => {
  const name = str(data["name"])
  const author = str(data["author"])
  if (name === undefined || author === undefined) return undefined
  const isPost = name.startsWith("t3_")
  const body = isPost
    ? [str(data["title"]), str(data["selftext"])].filter((part): part is string => part !== undefined && part.length > 0).join("\n\n")
    : (str(data["body"]) ?? "")
  const where = str(data["link_title"])
  return {
    kind: "message",
    chat: {
      chatID: modqueueChatID(subreddit),
      kind: "mailbox",
      title: `r/${subreddit} moderation queue`,
      parentID: subredditChatID(subreddit),
    },
    messageID: name,
    sender: { id: author, name: author, isSelf: selfName !== undefined && author.toLowerCase() === selfName.toLowerCase() },
    text: [
      `[${isPost ? "post" : "comment"} · ${queueReason(data)}]${where !== undefined && !isPost ? ` on "${where}"` : ""}`,
      body,
    ]
      .filter((part) => part.length > 0)
      .join("\n"),
    at: (num(data["created_utc"]) ?? Date.now() / 1000) * 1000,
  }
}

export const commentInbound = (subreddit: string, data: Record<string, unknown>, selfName: string | undefined): InboundEvent | undefined => {
  const name = str(data["name"]) ?? (str(data["id"]) === undefined ? undefined : `t1_${str(data["id"])}`)
  const author = str(data["author"])
  const linkID = str(data["link_id"])
  if (name === undefined || author === undefined || linkID === undefined) return undefined
  const parent = str(data["parent_id"])
  return {
    kind: "message",
    chat: {
      chatID: linkID,
      kind: "thread",
      title: str(data["link_title"]) ?? linkID,
      parentID: subredditChatID(subreddit),
    },
    messageID: name,
    sender: { id: author, name: author, isSelf: selfName !== undefined && author.toLowerCase() === selfName.toLowerCase() },
    text: str(data["body"]) ?? "",
    ...(parent === undefined ? {} : { replyTo: parent }),
    at: (num(data["created_utc"]) ?? Date.now() / 1000) * 1000,
  }
}

/**
 * The listing cursor. Reddit's `before` anchor DIES when the item it names is deleted — the poll
 * then returns nothing, forever. PRAW's production answer, copied here: keep a bounded set of seen
 * fullnames, dedup against it, and DROP the anchor whenever a page yields nothing new so the next
 * poll refetches unanchored. The seen-set (not the cursor) is what prevents double delivery.
 */
export interface ListingCursor {
  readonly before?: string
  readonly seen: readonly string[]
}
const SEEN_CAPACITY = 301

export const advanceCursor = (
  cursor: ListingCursor,
  fullnames: readonly string[],
): { readonly cursor: ListingCursor; readonly fresh: readonly string[] } => {
  const seen = new Set(cursor.seen)
  const fresh = fullnames.filter((name) => !seen.has(name))
  if (fresh.length === 0) return { cursor: { seen: cursor.seen }, fresh: [] } // anchor dropped on purpose
  const merged = [...cursor.seen, ...fresh].slice(-SEEN_CAPACITY)
  return { cursor: { before: fullnames[0], seen: merged }, fresh }
}

export const readCursor = (value: unknown): { posts: ListingCursor; comments: ListingCursor; modqueue: ListingCursor } => {
  const raw = (value ?? {}) as Record<string, unknown>
  const one = (key: string): ListingCursor => {
    const entry = (raw[key] ?? {}) as Record<string, unknown>
    const seen = Array.isArray(entry["seen"]) ? entry["seen"].filter((item): item is string => typeof item === "string") : []
    const before = str(entry["before"])
    return before === undefined ? { seen } : { before, seen }
  }
  return { posts: one("posts"), comments: one("comments"), modqueue: one("modqueue") }
}

// ── the driver ──────────────────────────────────────────────────────────────────────────────────

export interface RedditOptions {
  readonly pollIntervalMs?: number
  /** Stamped into the required User-Agent so Reddit can block old broken builds. Defaults to the
   *  installation's version — override only in tests, which must not track the product version. */
  readonly version?: string
}

const parseConfig = (account: Messenger.AccountInfo): Effect.Effect<RedditConfig, ConnectError> =>
  Effect.gen(function* () {
    const subreddit = normalizeSubreddit(account.settings["subreddit"] ?? "")
    const clientId = (account.settings["clientId"] ?? "").trim()
    const username = (account.settings["username"] ?? "").trim()
    if (subreddit.length === 0) return yield* Effect.fail(new ConnectError({ reason: "Which subreddit? Fill in the subreddit for this account in Settings." }))
    if (clientId.length === 0)
      return yield* Effect.fail(
        new ConnectError({ reason: "Reddit needs your own app's client ID (Settings → Messengers). Reddit's rate limit is per client ID, so each instance uses its own." }),
      )
    if (username.length === 0)
      return yield* Effect.fail(new ConnectError({ reason: "Reddit requires the bot account's username as contact info in every request. Add it in Settings." }))
    return { subreddit, clientId, username }
  })

export const make = (fetchImpl: FetchLike, loopbackFactory: LoopbackFactory, openBrowser: (url: string) => Effect.Effect<void>, options?: RedditOptions): Driver => {
  const pollIntervalMs = options?.pollIntervalMs ?? 20_000
  const version = options?.version ?? InstallationVersion

  /** Installed apps have NO secret — HTTP Basic is `client_id:` with an empty password. */
  const basic = (clientId: string) => `Basic ${btoa(`${clientId}:`)}`

  const tokenCall = (config: RedditConfig, form: Record<string, string>) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(`${WWW}/api/v1/access_token`, {
          method: "POST",
          headers: {
            Authorization: basic(config.clientId),
            "content-type": "application/x-www-form-urlencoded",
            "User-Agent": userAgent(config.username, version),
          },
          body: new URLSearchParams(form).toString(),
        })
        return { status: response.status, body: (await response.json().catch(() => undefined)) as unknown }
      },
      catch: (error) => new ConnectError({ reason: `Could not reach Reddit: ${String(error)}` }),
    })

  const login: LoginSupport = {
    begin: ({ account }) =>
      Effect.gen(function* () {
        const config = yield* parseConfig(account)
        const state = crypto.randomUUID()
        // Fixed port + exact URI: Reddit rejects a redirect that doesn't match what was registered,
        // so this must equal the string the setup recipe told the user to enter (REDIRECT_URI).
        const loopback = yield* loopbackFactory({ expectedState: state, provider: "Reddit", port: LOOPBACK_PORT, redirectUri: REDIRECT_URI })
        // `duration=permanent` is what earns a refresh token — without it the login dies in an hour.
        const url =
          `${WWW}/api/v1/authorize?` +
          new URLSearchParams({
            client_id: config.clientId,
            response_type: "code",
            state,
            redirect_uri: loopback.redirectUri,
            duration: "permanent",
            scope: SCOPES,
          }).toString()
        yield* openBrowser(url)

        const result = yield* Deferred.make<StoredCredential, LoginCodeError | ChallengeError>()
        yield* Effect.forkScoped(
          Effect.tryPromise({
            try: () => loopback.waitForCode,
            catch: (error) => new LoginCodeError({ reason: `Reddit sign-in didn't complete: ${String(error)}`, retryable: false }),
          }).pipe(
            Effect.flatMap((code) =>
              tokenCall(config, { grant_type: "authorization_code", code, redirect_uri: loopback.redirectUri }).pipe(
                Effect.mapError((error) => new ChallengeError({ message: error.reason })),
                Effect.flatMap((response) => {
                  const refresh = str((response.body as Record<string, unknown> | undefined)?.["refresh_token"])
                  if (refresh === undefined)
                    return Effect.fail(
                      new ChallengeError({
                        message: `Reddit did not return a lasting sign-in (${str((response.body as Record<string, unknown> | undefined)?.["error"]) ?? `HTTP ${response.status}`}). Check that the app is an "installed app" and that the redirect URI matches.`,
                      }),
                    )
                  return Effect.succeed({ refreshToken: refresh } satisfies StoredCredential)
                }),
              ),
            ),
            Effect.matchCauseEffect({
              onFailure: (cause) => Deferred.failCause(result, cause),
              onSuccess: (stored) => Deferred.succeed(result, stored),
            }),
          ),
        )

        const complete: LoginPending["complete"] = () =>
          Effect.gen(function* () {
            if (!(yield* Deferred.isDone(result)))
              return yield* Effect.fail(new LoginCodeError({ reason: "Still waiting for you to approve NovaClaw in your browser…", retryable: true }))
            return { session: JSON.stringify(yield* Deferred.await(result)) }
          })

        return {
          instructions: `A browser window is opening for Reddit — sign in as the moderator account and press Allow. If it didn't open, paste this link:\n${url}`,
          complete,
        } satisfies LoginPending
      }),
  }

  const connect = (ctx: ConnectContext) =>
    Effect.gen(function* () {
      const config = yield* parseConfig(ctx.account)
      const stored = ((): StoredCredential | undefined => {
        if (ctx.secret === undefined || ctx.secret.length === 0) return undefined
        try {
          const parsed = JSON.parse(ctx.secret) as StoredCredential
          return typeof parsed?.refreshToken === "string" ? parsed : undefined
        } catch {
          return undefined
        }
      })()
      if (stored === undefined)
        return yield* Effect.fail(new ConnectError({ reason: "This Reddit account isn't signed in yet — use Log in in Settings → Messengers." }))

      let accessToken: string | undefined
      let expiresAt = 0

      const token = Effect.gen(function* () {
        if (accessToken !== undefined && Date.now() < expiresAt - 60_000) return accessToken
        const response = yield* tokenCall(config, { grant_type: "refresh_token", refresh_token: stored.refreshToken })
        const body = response.body as Record<string, unknown> | undefined
        const fresh = str(body?.["access_token"])
        if (fresh === undefined) {
          // A revoked or withdrawn authorization is not a transport hiccup — park for the operator
          // rather than reconnect-looping against a decision only a human can undo.
          const reason = str(body?.["error"]) ?? `HTTP ${response.status}`
          return yield* Effect.fail(
            reason === "invalid_grant"
              ? new ChallengeError({ message: "Reddit no longer accepts this sign-in (access was revoked). Log in again in Settings → Messengers." })
              : new ConnectError({ reason: `Reddit refused the token refresh (${reason}).` }),
          )
        }
        accessToken = fresh
        expiresAt = Date.now() + (num(body?.["expires_in"]) ?? 3600) * 1000
        return fresh
      })

      // A revoked authorization must PARK the account for the operator, not reconnect-loop — but a
      // `Connection` method may only fail with ConnectError, so the challenge is raised where it
      // can be honoured: at connect (below, and again on every reconnect after the stream dies).
      const apiToken = token.pipe(
        Effect.mapError((error) => (error._tag === "MessengerDriver.ChallengeError" ? new ConnectError({ reason: error.message }) : error)),
      )

      const api = (path: string, init?: { method?: string; form?: Record<string, string> }) =>
        Effect.gen(function* () {
          const bearer = yield* apiToken
          // raw_json=1 or every `<`, `>`, `&` comes back HTML-escaped — silent corruption of
          // everything the agent reads.
          const url = `${OAUTH}${path}${path.includes("?") ? "&" : "?"}raw_json=1`
          return yield* Effect.tryPromise({
            try: async () => {
              const response = await fetchImpl(url, {
                method: init?.method ?? "GET",
                headers: {
                  Authorization: `bearer ${bearer}`,
                  "User-Agent": userAgent(config.username, version),
                  ...(init?.form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
                },
                ...(init?.form === undefined ? {} : { body: new URLSearchParams(init.form).toString() }),
              })
              return { status: response.status, body: (await response.json().catch(() => undefined)) as unknown }
            },
            catch: (error) => new ConnectError({ reason: `Reddit request failed: ${String(error)}` }),
          })
        })

      // Mint the first access token HERE, where a ChallengeError is still allowed to escape: a
      // withdrawn authorization parks the account and notifies the operator (§2.3), and every
      // reconnect runs this line again.
      yield* token

      // Who we are — also the self-echo test, since Reddit identifies authors by username.
      const meResponse = yield* api("/api/v1/me")
      if (meResponse.status === 401 || meResponse.status === 403)
        return yield* Effect.fail(new ConnectError({ reason: "Reddit rejected this sign-in — log in again in Settings → Messengers." }))
      const selfName = str((meResponse.body as Record<string, unknown> | undefined)?.["name"]) ?? config.username

      const queue = yield* Queue.unbounded<InboundEvent>()
      let cursors = readCursor(yield* ctx.cursor.get().pipe(Effect.orElseSucceed(() => undefined)))

      const children = (body: unknown): Thing[] => {
        const list = (body as { data?: { children?: unknown } })?.data?.children
        return Array.isArray(list) ? (list.filter((item) => typeof item === "object" && item !== null) as Thing[]) : []
      }

      /** One poll of one listing: newest-first from Reddit, emitted oldest-first. */
      const pollListing = (path: string, key: "posts" | "comments" | "modqueue", toEvent: (data: Record<string, unknown>) => InboundEvent | undefined) =>
        Effect.gen(function* () {
          const cursor = cursors[key]
          const query = new URLSearchParams({ limit: "100", ...(cursor.before === undefined ? {} : { before: cursor.before }) })
          const response = yield* api(`${path}?${query.toString()}`)
          if (response.status === 429) return // budget exhausted; the next tick retries
          if (response.status >= 400)
            return yield* Effect.fail(new ConnectError({ reason: `Reddit ${path} failed (HTTP ${response.status})` }))
          const rows = children(response.body)
          const names = rows.map((thing) => str(thing.data["name"]) ?? "").filter((name) => name.length > 0)
          const advanced = advanceCursor(cursor, names)
          cursors = { ...cursors, [key]: advanced.cursor }
          yield* ctx.cursor.set(cursors).pipe(Effect.ignore)
          const freshSet = new Set(advanced.fresh)
          for (const thing of [...rows].reverse()) {
            const name = str(thing.data["name"])
            if (name === undefined || !freshSet.has(name)) continue
            const event = toEvent(thing.data)
            if (event !== undefined) yield* Queue.offer(queue, event)
          }
        })

      const pump = Effect.gen(function* () {
        while (true) {
          yield* pollListing(`/r/${config.subreddit}/new`, "posts", (data) => postInbound(config.subreddit, data, selfName))
          yield* pollListing(`/r/${config.subreddit}/comments`, "comments", (data) => commentInbound(config.subreddit, data, selfName))
          // The queue is polled too: a report can land on a week-old comment that no `/new` poll
          // will ever surface again, and a report is precisely what should wake a moderator. A
          // failure here is NOT fatal — the bot may simply lack the `posts` mod permission, and
          // losing the public listings over that would be a worse outcome than a quiet queue.
          yield* pollListing(`/r/${config.subreddit}/about/modqueue`, "modqueue", (data) => modqueueInbound(config.subreddit, data, selfName)).pipe(
            Effect.catchCause(() => Effect.void),
          )
          yield* Effect.sleep(Duration.millis(pollIntervalMs))
        }
      })
      yield* Effect.forkScoped(pump.pipe(Effect.catchCause(() => Queue.shutdown(queue))))

      const send = (chatID: string, message: OutboundMessage) =>
        Effect.gen(function* () {
          if (message.file !== undefined)
            return yield* Effect.fail(new SendError({ reason: "Reddit comments can't carry file uploads — link to the file instead.", retryable: false }))
          const text = message.text ?? ""
          if (text.length === 0) return { messageID: "" }
          // Reply to the exact comment when asked; otherwise a top-level comment on the post. The
          // subreddit chat itself is not a place you can "reply" — submitting a post is a different
          // act with a title, deliberately out of scope.
          const parent = message.replyTo ?? (isPostChat(chatID) ? chatID : undefined)
          if (parent === undefined)
            return yield* Effect.fail(
              new SendError({
                reason: "Reply to a post or a comment (use the chat id of the post) — this driver doesn't submit new posts.",
                retryable: false,
              }),
            )
          const response = yield* api("/api/comment", { method: "POST", form: { thing_id: parent, text, api_type: "json" } }).pipe(
            Effect.mapError((error) => new SendError({ reason: error.reason, retryable: true })),
          )
          // The throttle Reddit answers with HTTP 200 — checked BEFORE status, since status is fine.
          const throttled = parseRateLimit(response.body)
          if (throttled !== undefined)
            return yield* Effect.fail(
              new SendError({ reason: `Reddit is throttling this account — retry in about ${Math.ceil(throttled.retryAfterMs / 1000)}s.`, retryable: true }),
            )
          const failure = parseApiError(response.body)
          if (failure !== undefined) return yield* Effect.fail(new SendError({ reason: `Reddit refused the comment (${failure})`, retryable: false }))
          if (response.status >= 400)
            return yield* Effect.fail(new SendError({ reason: `Reddit refused the comment (HTTP ${response.status})`, retryable: response.status >= 500 }))
          const things = (response.body as { json?: { data?: { things?: unknown } } })?.json?.data?.things
          const first = Array.isArray(things) ? (things[0] as Thing | undefined) : undefined
          return { messageID: str(first?.data?.["name"]) ?? "" }
        })

      const listChats = () =>
        Effect.gen(function* () {
          const out: ChatSnapshot[] = [
            { chatID: subredditChatID(config.subreddit), kind: "channel", title: `r/${config.subreddit}` },
            {
              chatID: modqueueChatID(config.subreddit),
              kind: "mailbox",
              title: `r/${config.subreddit} moderation queue (reported + filtered)`,
              parentID: subredditChatID(config.subreddit),
            },
          ]
          const response = yield* api(`/r/${config.subreddit}/new?limit=25`)
          if (response.status >= 400) return out
          for (const thing of children(response.body)) {
            const name = str(thing.data["name"])
            const title = str(thing.data["title"])
            if (name === undefined || title === undefined) continue
            out.push({ chatID: name, kind: "thread", title, parentID: subredditChatID(config.subreddit) })
          }
          return out
        })

      const history = (chatID: string, limit: number) =>
        Effect.gen(function* () {
          const entries: HistoryEntry[] = []
          // Reading the queue is how an agent triages on purpose rather than only when pushed.
          if (isModqueueChat(chatID)) {
            const response = yield* api(`/r/${config.subreddit}/about/modqueue?limit=${Math.min(100, limit)}`)
            if (response.status === 403)
              return yield* Effect.fail(
                new ConnectError({ reason: "Reddit refused the moderation queue — this account needs the `posts` moderator permission on the subreddit." }),
              )
            for (const thing of [...children(response.body)].reverse()) {
              const event = modqueueInbound(config.subreddit, thing.data, selfName)
              if (event?.kind !== "message") continue
              entries.push({
                messageID: event.messageID,
                senderID: event.sender.id,
                senderName: event.sender.name,
                outgoing: event.sender.isSelf,
                ...(event.text === undefined ? {} : { text: event.text }),
                at: event.at,
              })
            }
            return entries
          }
          if (!isPostChat(chatID)) {
            // The subreddit's own "history" is its recent posts.
            const response = yield* api(`/r/${config.subreddit}/new?limit=${Math.min(100, limit)}`)
            for (const thing of [...children(response.body)].reverse()) {
              const event = postInbound(config.subreddit, thing.data, selfName)
              if (event?.kind !== "message") continue
              entries.push({
                messageID: event.messageID,
                senderID: event.sender.id,
                senderName: event.sender.name,
                outgoing: event.sender.isSelf,
                ...(event.text === undefined ? {} : { text: event.text }),
                at: event.at,
              })
            }
            return entries
          }
          const response = yield* api(`/r/${config.subreddit}/comments/${bareID(chatID)}?limit=${Math.min(100, limit)}&sort=old`)
          // A comment-tree response is [post listing, comment listing]; both are things we render.
          const listings = Array.isArray(response.body) ? (response.body as unknown[]) : []
          for (const [index, listing] of listings.entries()) {
            for (const thing of children(listing)) {
              const event = index === 0 ? postInbound(config.subreddit, thing.data, selfName) : commentInbound(config.subreddit, thing.data, selfName)
              if (event?.kind !== "message") continue
              entries.push({
                messageID: event.messageID,
                senderID: event.sender.id,
                senderName: event.sender.name,
                outgoing: event.sender.isSelf,
                ...(event.text === undefined ? {} : { text: event.text }),
                at: event.at,
              })
            }
          }
          return entries.slice(-limit)
        })

      const moderate = (chatID: string, act: ModerationAct) =>
        Effect.gen(function* () {
          const request = moderationRequest(config.subreddit, chatID, act)
          if ("refusal" in request) return yield* Effect.fail(new ModerationError({ reason: request.refusal }))
          const response = yield* api(request.path, { method: "POST", form: request.form }).pipe(
            Effect.mapError((error) => new ModerationError({ reason: error.reason })),
          )
          const failure = parseApiError(response.body)
          if (failure !== undefined) return yield* Effect.fail(new ModerationError({ reason: `Reddit refused (${failure})` }))
          if (response.status >= 400)
            return yield* Effect.fail(
              new ModerationError({
                reason:
                  response.status === 403
                    ? "Reddit refused (403) — the bot account needs the matching moderator permission on this subreddit."
                    : `Reddit refused (HTTP ${response.status})`,
              }),
            )
        })

      return { inbound: Stream.fromQueue(queue), send, listChats, history, moderate } satisfies Connection
    })

  return {
    id: "reddit",
    meta: {
      id: "reddit",
      name: "Reddit",
      icon: "bubble-5",
      auth: "login",
      loginStyle: "browser",
      settings: [
        { type: "text", key: "subreddit", message: "Which subreddit does this account moderate?", placeholder: "r/novaclaw" },
        { type: "text", key: "username", message: "The Reddit account NovaClaw will act as", placeholder: "novaclaw-bot" },
        { type: "text", key: "clientId", message: "Your Reddit app's client ID", placeholder: "from reddit.com/prefs/apps" },
      ],
      loginPrompts: [],
      setup: {
        url: "https://www.reddit.com/prefs/apps",
        urlLabel: "Open your Reddit app settings",
        steps: [
          "Sign in as the account that will moderate (or a dedicated bot account), then at reddit.com/prefs/apps press 'create another app…'.",
          "Choose 'installed app' (it has no secret to leak) and set the redirect URI to EXACTLY http://127.0.0.1:8080 — Reddit matches it character for character, and NovaClaw catches the redirect on that port locally.",
          "Copy the client ID — the short string just under the app's name, NOT the secret — into the field below, with the bot account's username and the subreddit it moderates.",
          "Make that account a moderator of the subreddit with at least the Posts, Access and Mail permissions, and accept the mod invite from the account itself.",
          "Press Add & log in: a browser opens, you approve NovaClaw as that account, and the sign-in is stored. The rate limit is per app, which is why you use your own client ID rather than a shared one.",
          "Keep the User-Agent honest (NovaClaw sends your username in it — Reddit's rule) and, if Reddit later asks you to register the app for a label, do so; creating the app is enough to start.",
        ],
      },
      capabilities: CAPS,
    },
    capabilities: () => CAPS,
    login,
    connect,
  }
}
