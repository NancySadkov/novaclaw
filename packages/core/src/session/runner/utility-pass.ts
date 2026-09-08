export * as UtilityPass from "./utility-pass"

/**
 * What every UTILITY pass shares: it asks the model for a short string or a small JSON blob — a
 * title, an extraction, a yes/no verdict, an ordering — and never for extended reasoning.
 *
 * **The structural switch, and why it is only the first line of defence.** `enable_thinking:false`
 * IS honoured by the current test model (holo3.1: reasoning chars drop to 0 and latency roughly
 * halves, ~3.5s → ~1.7s, measured 2026-08-06) and it is a REQUEST, never a guarantee — a growing
 * class of models ignores it. So a pass that sends this still needs its own mechanical backstop:
 * `UtilityCap` for the empty-reply cliff, a wall-clock bound where a caller can degrade instead of
 * wait. Sending it is cheap and removes the common case; relying on it alone is how a pass ends up
 * spending an interactive turn's latency thinking about a list of numbers.
 */
export const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } } as const
