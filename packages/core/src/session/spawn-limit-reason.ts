/**
 * **The quota reasons, for every door that has to name one.**
 *
 * ⚠️ This list is a LEAF on purpose. `SpawnLimitError` lives in `spawner.ts`, which reaches the whole
 * session kernel, and `worker-protocol.ts` is imported by the worker boundary — so neither can import
 * the other to share the union, and both hand-wrote it. That is not a style complaint: the copy in
 * `worker-protocol.ts` carries a comment recording exactly what happened when `pressure` was added to
 * the kernel side alone, and the symptom was *"an unrelated-looking handler-signature error in
 * `session-worker/execution.ts`"* — three files and one protocol away from the change that caused it.
 * `join-deadline.ts` is a leaf for the same reason.
 *
 * ⭐ **The type is derived from the array, not written beside it**, so adding a reason here makes
 * every door that names one fail to compile until it is worded — which is the only moment a new refusal
 * can be given a sentence instead of arriving as `undefined`.
 *
 * - `depth`     — the session chain is already too deep to fork again.
 * - `children`  — this officer's worker tree is at its ceiling. A CAP: it clears when a worker finishes.
 * - `rate`      — too many spawns in the last minute.
 * - `pressure`  — the machine is low on memory. Nobody's fault, and it clears on its own.
 * - `disabled`  — this officer is set to use NO workers; its work goes to colleagues. A POLICY, not a
 *                 cap: nothing about waiting changes it, so no wording may invite a retry.
 */
export const SPAWN_LIMIT_REASONS = ["depth", "children", "rate", "pressure", "disabled"] as const

export type SpawnLimitReason = (typeof SPAWN_LIMIT_REASONS)[number]
