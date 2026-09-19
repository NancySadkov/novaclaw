export * as ContextManager from "./context-manager"

import { SessionContextEpoch } from "./context-epoch"

/**
 * THE CONTEXT MANAGER — the ONE seam every context read or write goes through.
 *
 * 🔴 Owner, 2026-09-17: *"context circle interacts with the ContextManager to get the required data.
 * In fact, any core part doing anything with context should never go around ContextManager.
 * Otherwise we risk accumulating more such bugs."*
 *
 * The bug that produced the rule: the Context indicator read the live prompt from a route that also
 * served captured request FILES. When the capture was stale, the circle showed an old prompt as the
 * current one, and clearing the chat could not fix it because a file is not context. The fix is not
 * "be careful which field the UI reads" — it is that context has exactly ONE accessor, and a caller
 * reaches the baseline through it or not at all.
 *
 * `SessionContextEpoch` (`context-epoch.ts`) remains the STORAGE layer: the epoch row, the snapshot,
 * the replace-on-change rule. This module is the narrow, named surface over it, so a new reader
 * cannot quietly grow a second path to the same data. That invariant is enforced by
 * `test/context-manager-single-seam.test.ts`, which fails on a second importer rather than trusting a
 * reviewer to notice.
 *
 * ⚠️ What is NOT here, deliberately: captured provider requests (`PromptCapture`). Those are
 * historical debug artifacts on the agent's scratch disk, not the session's context; they are served
 * by their own endpoint and read only on an explicit export. Nothing that shows the LIVE context may
 * touch them.
 */

/**
 * The live system prompt for a session — the stored context-epoch baseline, regenerated whenever a
 * prompt component changes. `undefined` before the first turn (or when the session has no prompt).
 *
 * ⚠️ This is RUNTIME STATE. It never reads a file, so it can never present a stale capture as the
 * current prompt.
 */
export const baseline = SessionContextEpoch.baselineOf

/** The admitted source value for the current epoch, including frozen runtime observations. */
export const sourceValue = SessionContextEpoch.sourceValue

/** Render-and-store the baseline for a session that has none yet (the first turn). */
export const initialize = SessionContextEpoch.initialize

/** Reconcile/rebuild the baseline, including the `forceReplace` a changed component asks for. */
export const prepare = SessionContextEpoch.prepare

/** Drop the stored epoch so the next turn renders a fresh baseline (a compaction, a fork, a move). */
export const reset = SessionContextEpoch.reset

/** Publish a context update onto the session's event stream. */
export const publishUpdate = SessionContextEpoch.publishUpdate

export type SourcePresence = SessionContextEpoch.SourcePresence
