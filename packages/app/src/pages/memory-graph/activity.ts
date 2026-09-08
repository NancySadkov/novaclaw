/**
 * WHAT THE MEMORY STORE IS DOING RIGHT NOW — the pure half of the live overlay.
 *
 * Everything here is a function of (previous state, one event, the clock). No Solid, no fetch, no
 * DOM: `activity-live.ts` wires it to the instance event stream and `memory-graph.tsx` draws it.
 * The split is not tidiness — the overlay's whole claim is "you can see it happen", and a claim
 * about ordering, expiry and backlogs is only testable if the clock is an argument.
 *
 * 🔴 **These events are LIVE and never durable** (`schema/memory-event.ts`). There is no sequence
 * number to resume from and no replay endpoint, so a "watermark" here cannot mean "give me
 * everything after N". It means: *this view has already reflected everything up to this moment;
 * anything older than it is confirmed, and a gap in the stream is repaired by RE-READING the store,
 * never by asking for the missed events.* That is why every payload carries ids rather than rows —
 * a lost event costs an animation, never a fact.
 */

import type { ServerStreamStatus } from "@/context/server-sdk"

// --- the wire, decoded defensively -------------------------------------------------------------

export type RecallSurface = "auto-recall" | "kb-tool" | "http" | "unknown"

export interface RecallHit {
  readonly id: string
  /** 1-based, in the order the caller was handed them. */
  readonly rank: number
  readonly score: number
  readonly scope: string
}

export type MemoryActivity =
  | {
      readonly kind: "claim"
      readonly id: string
      readonly scope: string
      readonly statement: string
      readonly status: string
      readonly identified: boolean
      readonly deduped: boolean
      readonly superseded: readonly string[]
      readonly subject: string | undefined
      readonly predicate: string | undefined
    }
  | {
      readonly kind: "item"
      readonly id: string
      readonly scope: string
      readonly itemKind: string
      readonly name: string | undefined
      readonly text: string
    }
  | {
      readonly kind: "status"
      readonly id: string
      readonly status: string
      readonly reason: "archived" | "restored" | "flagged" | "evidence-moved"
    }
  | { readonly kind: "forgotten"; readonly id: string; readonly mode: "invalidate" | "purge" }
  | {
      readonly kind: "recalled"
      readonly fingerprint: string
      readonly surface: RecallSurface
      readonly scopes: readonly string[]
      readonly hits: readonly RecallHit[]
      readonly considered: number
    }

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const bool = (value: unknown): boolean => value === true
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)
const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const SURFACES: readonly RecallSurface[] = ["auto-recall", "kb-tool", "http", "unknown"]
const surfaceOf = (value: unknown): RecallSurface => {
  const found = SURFACES.find((surface) => surface === value)
  return found ?? "unknown"
}

const REASONS = ["archived", "restored", "flagged", "evidence-moved"] as const

/**
 * Turn one bus envelope into an activity, or `undefined` if it is not one of ours.
 *
 * ⚠️ **Structural, not schema-decoded.** The app receives `{type, properties}` off an SSE stream it
 * does not own the encoder for, and a viewer that throws on an unexpected shape is a viewer that
 * crashes to a dead end the first time a field is added — the one thing the vision forbids. So
 * every field is read defensively and a payload missing its id is dropped rather than rendered as
 * a memory with no name.
 */
export function decodeMemoryEvent(event: { readonly type?: unknown; readonly properties?: unknown }):
  | MemoryActivity
  | undefined {
  const type = str(event.type)
  if (type === undefined || !type.startsWith("memory.")) return undefined
  const props = (event.properties ?? {}) as Record<string, unknown>
  switch (type) {
    case "memory.claim.recorded": {
      const id = str(props.id)
      if (!id) return undefined
      return {
        kind: "claim",
        id,
        scope: str(props.scope) ?? "global",
        statement: str(props.statement) ?? "",
        status: str(props.status) ?? "active",
        identified: bool(props.identified),
        deduped: bool(props.deduped),
        superseded: strings(props.superseded),
        subject: str(props.subject),
        predicate: str(props.predicate),
      }
    }
    case "memory.item.recorded": {
      const id = str(props.id)
      if (!id) return undefined
      return {
        kind: "item",
        id,
        scope: str(props.scope) ?? "global",
        itemKind: str(props.kind) ?? "episode",
        name: str(props.name),
        text: str(props.text) ?? "",
      }
    }
    case "memory.claim.status": {
      const id = str(props.id)
      const reason = REASONS.find((candidate) => candidate === props.reason)
      if (!id || !reason) return undefined
      return { kind: "status", id, status: str(props.status) ?? "active", reason }
    }
    case "memory.forgotten": {
      const id = str(props.id)
      if (!id) return undefined
      return { kind: "forgotten", id, mode: props.mode === "purge" ? "purge" : "invalidate" }
    }
    case "memory.recalled": {
      const raw = Array.isArray(props.hits) ? (props.hits as Record<string, unknown>[]) : []
      const hits: RecallHit[] = []
      for (const hit of raw) {
        const id = str(hit?.id)
        if (!id) continue
        hits.push({ id, rank: num(hit.rank), score: num(hit.score), scope: str(hit.scope) ?? "global" })
      }
      return {
        kind: "recalled",
        fingerprint: str(props.fingerprint) ?? "",
        surface: surfaceOf(props.surface),
        scopes: strings(props.scopes),
        hits,
        considered: num(props.considered),
      }
    }
    default:
      return undefined
  }
}

// --- the feed ----------------------------------------------------------------------------------

export type FeedTone = "write" | "correction" | "retire" | "recall" | "flag" | "forget"

export interface FeedEntry {
  /**
   * ⚠️ A STABLE identity for `<For>`, which keys by REFERENCE. The counter is minted once when the
   * entry is built and the entry object is never rebuilt — a caption re-derived per render would
   * remount every row on every event and the feed would flicker instead of scrolling.
   */
  readonly key: string
  readonly at: number
  readonly tone: FeedTone
  /** ONE line — principle 12(d). Everything longer is `detail`, shown on demand. */
  readonly caption: string
  readonly detail: string | undefined
  /** What it touched, so a caption can select the mark it is about. Hubs are never in here. */
  readonly ids: readonly string[]
}

/**
 * HOW MANY CAPTIONS THE FEED KEEPS: 50.
 *
 * 🔴 The bound is not a memory budget, it is an honesty budget. These events are LIVE and never
 * durable, so anything the feed drops is gone from this transport forever — and anything it kept
 * across a reconnect would be a record with a hole in it that looks continuous. Fifty is about a
 * screen and a half of scrollback: enough to see a correction you just caused and the recall that
 * preceded it, short enough that nobody mistakes it for the record. **The record is the graph**,
 * reachable through the History lens, which is the surface that can actually answer "and then
 * what happened" after the tab has been closed.
 */
export const FEED_MAX = 50

const quote = (text: string, limit = 90) =>
  text.length > limit ? `“${text.slice(0, limit - 1)}…”` : `“${text}”`

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const SURFACE_WORDS: Record<RecallSurface, string> = {
  "auto-recall": "while answering",
  "kb-tool": "on request",
  http: "over the API",
  unknown: "",
}

/** What a person watching should read. One line, in their words, never a type name. */
export function captionFor(activity: MemoryActivity): { caption: string; detail?: string; tone: FeedTone } {
  switch (activity.kind) {
    case "claim": {
      if (activity.deduped)
        return {
          caption: `Already knew ${quote(activity.statement)}`,
          detail: "Nothing changed — the same claim was already on file.",
          tone: "write",
        }
      if (activity.superseded.length > 0)
        return {
          caption: `Corrected: ${quote(activity.statement)}`,
          detail: `This replaces ${plural(activity.superseded.length, "earlier claim", "earlier claims")}, which moved to history rather than being deleted.`,
          tone: "correction",
        }
      return {
        caption: `Learned ${quote(activity.statement)}`,
        // ⚠️ Whether the harness accepted an IDENTITY is the difference between a claim that can be
        // corrected later and one that can only pile up beside its contradiction. That is worth
        // saying once, on demand, rather than never.
        detail: activity.identified
          ? `Filed as ${activity.subject ?? "?"} · ${activity.predicate ?? "?"}, so a later answer can correct it.`
          : "Filed without an identity, so nothing can correct it later — it can only be forgotten.",
        tone: "write",
      }
    }
    case "item": {
      const what = activity.name?.trim()
      if (activity.itemKind === "passage")
        return {
          caption: what ? `Filed a passage from ${what}` : "Filed a passage",
          detail: activity.text || undefined,
          tone: "write",
        }
      if (activity.itemKind === "entity")
        return {
          caption: what ? `Learned about ${what}` : `Learned ${quote(activity.text)}`,
          detail: what ? activity.text : undefined,
          tone: "write",
        }
      return { caption: `Noted ${quote(activity.text)}`, detail: undefined, tone: "write" }
    }
    case "status": {
      if (activity.reason === "archived")
        return { caption: "Archived a memory", detail: "It stays in History and can be restored.", tone: "retire" }
      if (activity.reason === "restored")
        return { caption: "Restored a memory", detail: "It counts as current again.", tone: "write" }
      if (activity.reason === "evidence-moved")
        return {
          caption: "Flagged a memory — its source moved",
          detail:
            "The file or page it came from is no longer where it was. That makes the CITATION stale, not the fact false, so the claim is kept and down-ranked rather than dropped.",
          tone: "flag",
        }
      return { caption: "Flagged a memory for review", detail: undefined, tone: "flag" }
    }
    case "forgotten":
      return activity.mode === "purge"
        ? { caption: "Erased a memory", detail: "Purged — this one is not in History either.", tone: "forget" }
        : { caption: "Forgot a memory", detail: "Reversible: it is still in History.", tone: "forget" }
    case "recalled": {
      const where = SURFACE_WORDS[activity.surface]
      const suffix = where ? ` ${where}` : ""
      if (activity.hits.length === 0)
        return {
          caption: `Looked${suffix} and found nothing`,
          // 🔴 The most useful line this app can show is why Nova did NOT remember something, and
          // it is only sayable because the store publishes empty recalls too.
          detail: "Nothing in the scopes it searched matched the question.",
          tone: "recall",
        }
      return {
        caption: `Recalled ${plural(activity.hits.length, "memory", "memories")}${suffix}`,
        detail:
          activity.considered > activity.hits.length
            ? `${activity.considered} were considered; the highlighted ones are what it used, best first.`
            : "Highlighted best first.",
        tone: "recall",
      }
    }
  }
}

/** The ids one activity is ABOUT, newest-first — what its caption can select on the map. */
export function idsOf(activity: MemoryActivity): readonly string[] {
  switch (activity.kind) {
    case "claim":
      return [activity.id, ...activity.superseded]
    case "item":
    case "status":
    case "forgotten":
      return [activity.id]
    case "recalled":
      return activity.hits.map((hit) => hit.id)
  }
}

// --- the overlay's state -----------------------------------------------------------------------

export type FlareTone = "new" | "edit" | "retire"

export interface Flare {
  readonly at: number
  readonly tone: FlareTone
  /**
   * When the mark this flare is about first EXISTED on the canvas, or `undefined` while it still
   * does not.
   *
   * 🔴 **A new memory's flare would otherwise burn out before its node arrived.** Measured in the
   * app: a write is captioned within ~100 ms of the event, but the NODE only appears after the
   * debounced re-read (`REFRESH_DEBOUNCE_MS` plus a fetch), so counting a flare's life from the
   * event spent most of it on an empty patch of canvas — and if the re-read were slow, all of it.
   * "A new claim flares" would then be true of the code and false on screen.
   */
  readonly shownAt: number | undefined
}

export interface RecallHighlight {
  readonly at: number
  readonly fingerprint: string
  readonly surface: RecallSurface
  /** id → 1-based rank. The map highlights in this order and dims everything absent. */
  readonly ranks: ReadonlyMap<string, number>
  readonly considered: number
  readonly found: number
}

export interface ActivityState {
  readonly entries: readonly FeedEntry[]
  readonly flares: ReadonlyMap<string, Flare>
  readonly recall: RecallHighlight | undefined
  /**
   * Claims this session watched retire. The store is the authority and a re-read confirms it; this
   * is what lets the mark change the INSTANT it happens instead of at the next fetch.
   */
  readonly retired: ReadonlySet<string>
  /** Monotonic, only ever used to mint a feed key. */
  readonly seq: number
  /** The newest moment this view has reflected. See the header: not a resume token. */
  readonly watermark: number
  /** Event times inside the burst window, so a replay can be recognised without a clock of its own. */
  readonly recent: readonly number[]
  /** Something changed that only a re-read can render correctly (a new node, a new edge). */
  readonly dirty: boolean
  /**
   * How many events the view could not show happening — a backlog, not merely an un-animated fold.
   *
   * ⚠️ **Reduced motion does NOT count here, and that distinction is the point.** Both cases fold
   * without a flare, but only one of them is news: "twelve changes arrived while you were away" is
   * something the user could not have known, while "we did not animate, as you asked" is them
   * getting what they set. A counter that conflated the two would put a notice on screen after
   * every single event for exactly the person who asked for less.
   */
  readonly skipped: number
}

export const emptyActivity = (): ActivityState => ({
  entries: [],
  flares: new Map(),
  recall: undefined,
  retired: new Set(),
  seq: 0,
  watermark: 0,
  recent: [],
  dirty: false,
  skipped: 0,
})

/** How long a flare lives. Long enough to catch the eye, short enough not to litter the map. */
export const FLARE_MS = 1600
/**
 * The longest a flare may wait for its mark to appear before giving up.
 *
 * ⚠️ A flare whose node NEVER arrives is a real case, not a hypothetical: the mark may be filtered
 * out by a kind chip, may belong to another colleague's cabinet, or may fall outside the slice the
 * server sent. Without this cap those flares would sit in the map forever, waiting for something
 * that is not coming.
 */
export const FLARE_MAX_WAIT_MS = 4000
/** How long a recall keeps the map focused on its hits before everything comes back up. */
export const RECALL_HOLD_MS = 7000
/** Stagger between ranks, so "best first" is something you SEE rather than something you are told. */
export const RANK_STAGGER_MS = 90
export const RANK_STAGGER_MAX_MS = 900

export const rankDelayMs = (rank: number): number =>
  Math.min(RANK_STAGGER_MAX_MS, Math.max(0, rank - 1) * RANK_STAGGER_MS)

/** How long a rank badge's pop takes once its turn arrives. */
export const RANK_REVEAL_MS = 220
/** The ring's settled radius, and the radius it pops in FROM. */
export const RANK_RING_R = 11
export const RANK_RING_FROM_R = 18

/**
 * 🔴 **NOTHING LOAD-BEARING MAY RIDE AN ANIMATION.**
 *
 * Measured twice in the Browser pane on 2026-08-25, and the second measurement is the instructive
 * one. First attempt: base `opacity="0"` with `<animate from="0" to="1">` — `document.hidden` was
 * true, the animation never ticked, computed opacity stayed **0**, and the rank badge did not
 * exist. Second attempt: base `opacity="1"` with the delay moved out of `begin` and into
 * `keyTimes` — computed opacity was **still 0**, because a SMIL animation that has BEGUN (the
 * default `begin` is `0s`) pins the attribute to its first value and a frozen timeline never
 * advances past it. Starting is enough to override the base; ticking is what the value depends on.
 *
 * So the fix is not a better animation, it is to animate something else. Opacity is fixed at 1 and
 * the stagger rides the RADIUS: if the timeline never advances the ring is frozen a few pixels
 * wide of its resting size — visibly present, in the right place, saying the right thing. The
 * choreography is the only thing a stalled clock can cost.
 *
 * The delay still lives in `keyTimes` rather than `begin`, so the ring does not sit at its settled
 * size and then jump back out when its turn arrives.
 */
export function rankPop(rank: number): { values: string; keyTimes: string; dur: string } {
  const delay = rankDelayMs(rank)
  const total = delay + RANK_REVEAL_MS
  const hold = (delay / total).toFixed(4)
  return {
    values: `${RANK_RING_FROM_R};${RANK_RING_FROM_R};${RANK_RING_R}`,
    keyTimes: `0;${hold};1`,
    dur: `${total}ms`,
  }
}

/**
 * A BURST IS A REPLAY, NOT AN EVENT YOU CAN WATCH.
 *
 * A backgrounded tab's SSE stream buffers and delivers everything at once when it wakes; so does an
 * ingest of a hundred passages. Thirteen flares in four hundred milliseconds is not thirteen things
 * a person saw happen, it is a strobe. Past the limit the fold keeps every caption and every state
 * change and simply stops animating — which is the ledger's rule ("skip stale animation backlogs
 * without skipping state") expressed as a rate rather than as a flag somebody has to clear.
 */
export const BURST_WINDOW_MS = 400
export const BURST_LIMIT = 12

export function isBurst(state: ActivityState, now: number): boolean {
  let count = 0
  for (const at of state.recent) if (now - at < BURST_WINDOW_MS) count++
  return count >= BURST_LIMIT
}

const withRecent = (recent: readonly number[], now: number): readonly number[] => {
  const kept = recent.filter((at) => now - at < BURST_WINDOW_MS)
  kept.push(now)
  return kept
}

/**
 * Fold one activity into the view.
 *
 * `animate: false` keeps the CAPTION and every state change and drops only the flare — that single
 * distinction is what serves both reduced motion and a stale backlog, because they want exactly the
 * same thing for exactly different reasons.
 */
export function foldActivity(
  state: ActivityState,
  activity: MemoryActivity,
  options: {
    readonly now: number
    readonly animate: boolean
    /**
     * Was this one the user COULD NOT have seen — a gap or a replay — rather than one they chose
     * not to see? Only these are counted, and the notice is written from the count.
     */
    readonly missed?: boolean
  },
): ActivityState {
  const { now, animate } = options
  const seq = state.seq + 1
  const { caption, detail, tone } = captionFor(activity)
  const entry: FeedEntry = {
    key: `a${seq}`,
    at: now,
    tone,
    caption,
    detail,
    ids: idsOf(activity),
  }
  const entries = [entry, ...state.entries].slice(0, FEED_MAX)

  // ⚠️ `undefined` when nothing will animate, so the previous map is returned by IDENTITY and every
  // memo downstream of `flares` skips recomputing. Under reduced motion that is the whole fold.
  const flares = animate ? new Map(state.flares) : undefined
  const retired = new Set(state.retired)
  let recall = state.recall
  let dirty = state.dirty

  switch (activity.kind) {
    case "claim": {
      // A correction RIPPLES in place: the new claim flares as an edit rather than as a birth,
      // because the thing that happened is that an answer changed, not that one appeared.
      flares?.set(activity.id, { at: now, shownAt: undefined, tone: activity.superseded.length > 0 ? "edit" : "new" })
      for (const old of activity.superseded) {
        retired.add(old)
        flares?.set(old, { at: now, shownAt: undefined, tone: "retire" })
      }
      // A deduped claim added no node and no edge, so it needs no re-read.
      dirty = dirty || !activity.deduped
      break
    }
    case "item": {
      flares?.set(activity.id, { at: now, shownAt: undefined, tone: "new" })
      dirty = true
      break
    }
    case "status": {
      if (activity.status === "archived") retired.add(activity.id)
      else if (activity.status === "active") retired.delete(activity.id)
      flares?.set(activity.id, { at: now, shownAt: undefined, tone: activity.status === "archived" ? "retire" : "edit" })
      dirty = true
      break
    }
    case "forgotten": {
      retired.add(activity.id)
      flares?.set(activity.id, { at: now, shownAt: undefined, tone: "retire" })
      dirty = true
      break
    }
    case "recalled": {
      // ⚠️ A recall is a SLOT, not a list: the newest question is the one on screen. A backlog of
      // recalls therefore collapses to its last one for free, which is exactly right — replaying
      // four old questions' highlights would say four things that are no longer being asked.
      const ranks = new Map<string, number>()
      for (const hit of activity.hits) ranks.set(hit.id, hit.rank)
      recall = {
        at: now,
        fingerprint: activity.fingerprint,
        surface: activity.surface,
        ranks,
        considered: activity.considered,
        found: activity.hits.length,
      }
      // A recall changes nothing in the store, so it never asks for a re-read. That is the P2
      // gate's quiet half: an open viewer must not add work to the recall path.
      break
    }
  }

  return {
    entries,
    flares: flares ?? state.flares,
    recall,
    retired,
    seq,
    watermark: Math.max(state.watermark, now),
    recent: withRecent(state.recent, now),
    dirty,
    skipped: options.missed === true ? state.skipped + 1 : state.skipped,
  }
}

/**
 * Expire what has had its moment.
 *
 * ⚠️ Returns the SAME object when nothing expired. A pruner that minted a fresh state on every
 * animation frame would make every downstream memo recompute forever, which is how a "live" view
 * turns into a busy loop on an idle instance.
 */
export function pruneActivity(
  state: ActivityState,
  now: number,
  options?: {
    /**
     * Is this mark currently ON the canvas? Absent = assume yes, which is what a surface with no
     * canvas (a test, the list view) should assume — the flare then simply lives its ordinary span.
     */
    readonly isVisible?: (id: string) => boolean
  },
): ActivityState {
  let pruned: Map<string, Flare> | undefined
  const edit = () => {
    if (!pruned) pruned = new Map(state.flares)
    return pruned
  }
  for (const [id, flare] of state.flares) {
    // A flare's clock starts when its MARK EXISTS, not when the event arrived — see `Flare.shownAt`.
    const visible = options?.isVisible?.(id) ?? true
    const shownAt = flare.shownAt ?? (visible ? now : undefined)
    if (shownAt !== flare.shownAt) edit().set(id, { ...flare, shownAt })
    const burntOut = shownAt !== undefined && now - shownAt >= FLARE_MS
    const gaveUp = now - flare.at >= FLARE_MAX_WAIT_MS
    if (!burntOut && !gaveUp) continue
    edit().delete(id)
  }
  const recall = state.recall && now - state.recall.at >= RECALL_HOLD_MS ? undefined : state.recall
  if (pruned === undefined && recall === state.recall) return state
  return { ...state, flares: pruned ?? state.flares, recall }
}

/** The page has re-read the store; the change this state was standing in for is now confirmed. */
export const markSynced = (state: ActivityState): ActivityState =>
  state.dirty || state.skipped > 0 ? { ...state, dirty: false, skipped: 0 } : state

/** Drop the live overlay without dropping the feed — what a reconcile does before it animates. */
export const clearOverlay = (state: ActivityState): ActivityState =>
  state.flares.size === 0 && state.recall === undefined
    ? state
    : { ...state, flares: new Map(), recall: undefined }

// --- the link: watermark, gap, reconcile -------------------------------------------------------

export interface LinkState {
  /** Have we ever had a live stream? A first connection is not a RE-connection. */
  readonly seen: boolean
  /** Did we lose one we had? Only this earns a reconcile. */
  readonly lost: boolean
}

export const initialLink = (): LinkState => ({ seen: false, lost: false })

/**
 * Two questions the stream status answers, folded into one step.
 *
 * 🔴 **Only a link we ACTUALLY HAD can be lost.** The first `connecting → connected` is not a
 * reconnect and must not fire a re-read: the page's resources already fetched on mount, and an
 * extra round trip on every open is exactly the polling this transport exists to avoid.
 *
 * ⚠️ `idle` counts as lost. It is how the SDK reports a deliberately stopped stream (pagehide, or
 * the visibility handler aborting a stream that has been quiet too long), and a tab that comes back
 * from that has missed precisely as much as one that dropped.
 */
export function stepLink(link: LinkState, status: ServerStreamStatus): { link: LinkState; reconcile: boolean } {
  if (status === "connected") {
    if (link.lost) return { link: { seen: true, lost: false }, reconcile: true }
    return { link: { seen: true, lost: false }, reconcile: false }
  }
  return { link: { seen: link.seen, lost: link.seen }, reconcile: false }
}

/**
 * ONE reconcile, not one per flap.
 *
 * A stream that oscillates — a laptop lid, a phone changing networks — produces a `connected` every
 * few hundred milliseconds, and a re-read per edge would turn a bad connection into a load test on
 * the instance it is already struggling to reach.
 */
export const RECONCILE_MIN_GAP_MS = 1500

/**
 * WHAT THE CONNECTION IS DOING, in one calm line — or `undefined` when there is nothing to say.
 *
 * 🔴 The vision's rule, literally: *a calm "connection lost — reconnecting…", never a stack trace
 * or a white screen.* A healthy stream says NOTHING, because a permanent "connected" badge is a
 * status light nobody reads, and the moment it matters it has already trained the eye to skip it.
 *
 * ⚠️ It lives here rather than in the component so the sentence can be checked without a DOM. Every
 * branch is a state a real user reaches, and each has to be true of that state rather than merely
 * reassuring.
 */
export function linkSentence(status: ServerStreamStatus, reconciling: boolean): string | undefined {
  if (status === "connected") return reconciling ? "Catching up…" : undefined
  if (status === "reconnecting") return "Connection lost — reconnecting…"
  if (status === "connecting") return "Connecting…"
  return "Not watching yet."
}

export const mayReconcile = (lastAt: number | undefined, now: number): boolean =>
  lastAt === undefined || now - lastAt >= RECONCILE_MIN_GAP_MS

/**
 * How long after a write to re-read the graph.
 *
 * A write's flare lands instantly from the event; the NODE it is about only exists on the canvas
 * after a fetch. Debounced, because an extraction turn writes several claims in a row and one
 * re-read after the last of them draws the same picture as five would.
 */
export const REFRESH_DEBOUNCE_MS = 900
