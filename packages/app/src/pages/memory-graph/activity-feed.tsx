import { For, Show, type Component } from "solid-js"
import type { ServerStreamStatus } from "@/context/server-sdk"
import { FEED_MAX, linkSentence, type FeedEntry, type FeedTone } from "./activity"
import * as Timestamp from "@novaclaw/schema/time"

/**
 * THE ACTIVITY RAIL — what the memory store just did, in sentences.
 *
 * 🔴 **The captions are the part that survives everything.** Reduced motion drops the flares and the
 * dimming; a stale backlog drops them too; a throttled tab drops them a third time. In every one of
 * those cases the feed still says what happened, because a caption is a FACT and an animation is
 * only an emphasis. That asymmetry is the whole reason the fold has an `animate` flag rather than an
 * on/off switch.
 *
 * ⚠️ **It is a strip, not a log.** The events are live and never durable, so anything scrolled past
 * the bound is gone from this transport forever — and a longer list would look like a record with a
 * hole in it. The record is the graph, through the History lens.
 */

const TONE_COLOUR: Record<FeedTone, string> = {
  write: "#e0a33e", // gold — something learned
  correction: "#22d3ee", // cyan — an answer changed in place
  retire: "#94a3b8", // slate — set aside, still reachable
  recall: "#eab308", // amber — the store was asked something
  flag: "#e0a33e",
  forget: "#94a3b8",
}

/** Clock time, not "3 minutes ago" — a relative label needs a ticking clock, and a ticker on an
 *  idle page is a busy loop bought for a nicety. */
const clock = (at: number) => {
  return Timestamp.toDate(at)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) ?? ""
}

export const MemoryActivityFeedRail: Component<{
  entries: readonly FeedEntry[]
  streamStatus: ServerStreamStatus
  reconciling: boolean
  reducedMotion: boolean
  /** How many events were folded without animating — a throttled tab, or a bulk ingest. */
  skipped: number
  onSelect: (id: string) => void
}> = (props) => {
  const link = () => linkSentence(props.streamStatus, props.reconciling)
  return (
    <aside
      class="flex w-72 shrink-0 flex-col border-l border-v2-border-border-muted bg-v2-background-bg-layer-01"
      data-slot="memory-activity"
      data-stream={props.streamStatus}
      data-reduced-motion={props.reducedMotion ? "" : undefined}
    >
      <div class="flex items-center gap-2 border-b border-v2-border-border-muted px-3 py-2 text-[11px]">
        <span class="font-medium">Activity</span>
        <Show when={link()}>
          {(sentence) => (
            <span class="opacity-60" data-slot="memory-activity-link">
              {sentence()}
            </span>
          )}
        </Show>
        <span class="ml-auto opacity-40" data-slot="memory-activity-count">
          {props.entries.length}
        </span>
      </div>
      {/* 🔴 SAY WHEN THE ANIMATION WAS SKIPPED. A burst that arrived while the tab was in the
          background is folded silently — every caption kept, every flare dropped — and a viewer
          who was not told would read the calm map as "nothing happened while I was away". */}
      <Show when={props.skipped > 0}>
        <p
          class="border-b border-v2-border-border-muted px-3 py-1.5 text-[11px] opacity-60"
          data-slot="memory-activity-skipped"
        >
          {props.skipped} {props.skipped === 1 ? "change" : "changes"} arrived at once — listed, not animated.
        </p>
      </Show>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={props.entries.length > 0}
          fallback={
            <p class="px-3 py-3 text-[11px] leading-relaxed opacity-50" data-slot="memory-activity-empty">
              Nothing yet. This is where remembering, recalling and correcting show up as they happen — whichever
              colleague or tool caused them.
            </p>
          }
        >
          <ul class="flex flex-col">
            {/* ⚠️ `<For>` keys by REFERENCE, and these entries are minted once and never rebuilt
                (`foldActivity` prepends and slices), so a new event adds one row instead of
                remounting the list. A caption re-derived per render would flicker the whole rail
                on every event — which is the opposite of a feed you can read. */}
            <For each={props.entries}>
              {(entry) => (
                <li
                  class="border-b border-v2-border-border-muted/50 px-3 py-1.5"
                  data-slot="memory-activity-entry"
                  data-tone={entry.tone}
                >
                  <div class="flex items-start gap-2">
                    <span
                      class="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: TONE_COLOUR[entry.tone] }}
                      aria-hidden="true"
                    />
                    <div class="min-w-0 flex-1">
                      <button
                        type="button"
                        class="w-full text-left text-[11px] leading-snug break-words hover:underline disabled:cursor-default disabled:no-underline"
                        data-slot="memory-activity-caption"
                        disabled={entry.ids.length === 0}
                        onClick={() => entry.ids[0] && props.onSelect(entry.ids[0])}
                      >
                        {entry.caption}
                      </button>
                      {/* ONE line above, the rest ON DEMAND — principle 12(d). The explanation of
                          what an identity buys, or why a flag is not a deletion, is exactly the kind
                          of teaching this product owes and exactly the kind that must not be pasted
                          into every row of a feed. */}
                      <Show when={entry.detail}>
                        {(detail) => (
                          <details class="mt-0.5">
                            <summary class="cursor-pointer text-[10px] opacity-40 hover:opacity-70">why</summary>
                            <p class="mt-0.5 text-[10px] leading-snug opacity-60" data-slot="memory-activity-detail">
                              {detail()}
                            </p>
                          </details>
                        )}
                      </Show>
                    </div>
                    <span class="shrink-0 text-[10px] tabular-nums opacity-35">{clock(entry.at)}</span>
                  </div>
                </li>
              )}
            </For>
          </ul>
          <Show when={props.entries.length >= FEED_MAX}>
            <p class="px-3 py-2 text-[10px] opacity-40" data-slot="memory-activity-bound">
              Showing the last {FEED_MAX}. Older changes are in the graph, under History.
            </p>
          </Show>
        </Show>
      </div>
    </aside>
  )
}
