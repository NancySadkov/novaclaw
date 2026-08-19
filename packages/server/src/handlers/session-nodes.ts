import { SessionV2 } from "@novaclaw/core/session"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionPresence } from "@novaclaw/core/session/presence"
import { SessionReceipt } from "@novaclaw/core/session/receipt"
import { SessionTags } from "@novaclaw/core/session/tags"

/**
 * Every service the session handler groups in {@link ./session.ts} acquire **at build time**, in
 * one place, because three separate graphs must agree on them and the typecheck cannot make them.
 *
 * ## Why this file exists rather than three hand-kept lists
 *
 * Each `HttpApiBuilder.group` in `session.ts` opens with an `Effect.gen` that `yield*`s its
 * services *before* returning any handler. That runs when the group is BUILT, so a service the
 * group reads and a graph omits does not fail the one endpoint that uses it — it fails **every
 * test in the file that drives a real HTTP request**, with `Service not found` and nothing about
 * what the file was testing.
 *
 * 🔴 **The old arrangement was a comment asking the next author to remember, and it failed three
 * times.** `SessionReceipt` went missing when the receipt endpoint landed; `SessionEffectiveConfig`
 * when the resolved-config view started resolving through one entry point; and on 2026-08-19
 * `SessionPresence` — 14 red tests across two files, which sat unnoticed because they are the
 * `server` unit and the pinned baseline only covered `novaclaw:server`. The lesson this repo keeps
 * paying for is that **informational levers engage and mechanical ones convert**: the list is now a
 * value that all three graphs import, so adding a `yield*` to a group is one line here and the two
 * test kernels and production pick it up together.
 *
 * ⚠️ This is deliberately the *build-time* set, not "everything the handlers touch". A service
 * acquired inside a single handler body fails only that endpoint's request and belongs to whatever
 * graph that endpoint's test builds — it does not need to be here.
 */
/**
 * ⚠️ **The ORDER is production's original order, and it is not cosmetic.** These seven were
 * contiguous in `routes.ts`'s `applicationServices`, and lifting them into this constant with the
 * members rearranged (`SessionEffectiveConfig` moved from third to last) turned `novaclaw:server`
 * red — `POST /api/project invalidates the cache the kernel reads`, the suite that covers the
 * project-file cache `SessionEffectiveConfig` pulls in. Whatever the mechanism, a group's member
 * order is observable, so this list reproduces the sequence the shipped graph already had.
 * A reorder here is a behaviour change and needs its own gate run, not a tidy-up.
 */
export const SESSION_HANDLER_NODES = [
  SessionV2.node,
  SessionTags.node,
  SessionEffectiveConfig.node,
  SessionExecutionAttempt.node,
  SessionReceipt.node,
  SessionPresence.node,
  SessionExecution.node,
] as const
