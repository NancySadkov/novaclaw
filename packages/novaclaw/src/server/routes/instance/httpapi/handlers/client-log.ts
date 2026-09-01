export * as ClientLog from "./client-log"

import { RESERVED_ATTRIBUTES } from "@novaclaw/schema/log-events"

/**
 * **What `POST /log` accepts, and what it refuses.**
 *
 * ── what the route is FOR ───────────────────────────────────────────────────────────────────────
 *
 * The renderer's error ring (`app/src/utils/error-log.ts`) is a 200-entry in-memory buffer that
 * evaporates on reload, so a UI fault exists in exactly one place and dies before anybody can read
 * it. Meanwhile every server fault lands in `novaclaw.log`, which is bounded, rotated, greppable by
 * key, carried in the debug export and readable by the `log` tool. This route is the bridge: **a
 * client process's own faults reaching the instance log**, so that "the UI went white at 14:03" and
 * "the server threw at 14:03" are two lines in one file with one `run=` beside them.
 *
 * That is the whole purpose. It is NOT a general-purpose write endpoint, and every refusal below
 * follows from that: the caller is a NovaClaw client reporting its own trouble, not an author of log
 * records.
 *
 * ── ⚠️ it is an HTTP surface accepting caller-supplied content ──────────────────────────────────
 *
 * A log is the highest-density source of user content in the product, and this is the one door into
 * it that something outside the kernel can push through. Four refusals, in the order they were
 * measured to matter:
 *
 * 1. 🔴 **A caller could FORGE any column, including `event=`.** The handler annotated the record
 *    with the caller's `extra` map verbatim, and `observability/logging.ts` flattens annotations
 *    into top-level `key=value` columns — so `{"extra":{"event":"session.drain.exit"}}` put a second
 *    `event=` on the line, and `{"extra":{"level":"ERROR"}}` a second `level=`. Both are in
 *    `RESERVED_ATTRIBUTES`, whose own doc records the same collision shipping once before from the
 *    MCP relay. A forged `event=` defeats the entire keyed vocabulary: every saved query, every
 *    telemetry cluster and the `log` tool's own filters key off that column.
 *    → **Every caller key is namespaced under `client.extra.`**, which cannot collide with a
 *      reserved name or with any future one. A prefix is mechanical; a deny-list is a list somebody
 *      has to remember to extend.
 * 2. 🔴 **A caller could break logfmt outright.** Column NAMES are written unquoted
 *    (`` `${key}=${format(value)}` ``), so `{"extra":{"a b":1}}` emitted `client.extra.a b=1` and
 *    every naive `grep`/`cut` reader — which is this whole item's stated requirement — parses the
 *    line wrongly from there on.
 *    → **A key that is not `[A-Za-z][A-Za-z0-9._-]*` is dropped**, counted, and the count is
 *      reported on the line rather than swallowed.
 * 3. **Nothing bounded the payload.** One POST could carry a megabyte message and a thousand extra
 *    keys, straight into a byte budget the writer then evicts real history to honour.
 * 4. **Nothing bounded the RATE.** A renderer in a crash loop is the expected caller, not a
 *    hypothetical attacker, and it is the write amplifier: at a few thousand posts a second it would
 *    burn the 256 MB retention budget in minutes and evict the server-side lines that explain the
 *    crash. → a token bucket, sized so that a full 200-entry ring drain passes in one go and a
 *    sustained loop does not.
 *
 * ⚠️ **And the fifth rule is what none of them may do: logging must never take the instance down.**
 * So an oversize message is TRUNCATED rather than rejected — a truncated crash report beats a 400
 * during a crash — and a rate-limited post is answered `false` (the success schema already means
 * *written*), never with an exception and never with a silent `true`. Ruling 2: a subsystem does not
 * describe itself falsely, so "I dropped it" is an answer and `true` would be a lie.
 */

/** The one namespace every caller-supplied field lands in. Collision-proof by construction. */
export const EXTRA_PREFIX = "client.extra."
/** Our own field about the caller, and unforgeable *because* callers cannot escape the prefix. */
export const DROPPED_ATTRIBUTE = "client.dropped"

/** A column name that survives `grep`, `cut -d=` and every logfmt reader. */
export const SAFE_KEY = /^[A-Za-z][A-Za-z0-9._-]*$/
/** `client.service` is class `id` — a closed vocabulary — so it is slugged, not passed through. */
export const SAFE_SERVICE = /[^A-Za-z0-9._-]+/g

export const MAX_SERVICE_CHARS = 64
export const MAX_MESSAGE_CHARS = 4000
export const MAX_EXTRA_KEYS = 16
export const MAX_EXTRA_VALUE_CHARS = 512

/**
 * Sustained posts per second, and the burst that absorbs one drain of the renderer's ring.
 *
 * The ring is 200 entries (`app/src/utils/error-log.ts`), so a burst below that would turn the
 * feature's own primary use — *flush what I collected before I died* — into a partial report. The
 * sustained rate is what a crash loop is left with: ~5 lines/s against a measured baseline of
 * ~134 KB/day, which keeps a runaway client an order of magnitude below the retention budget instead
 * of eating it.
 */
export const BURST = 240
export const PER_SECOND = 5

export const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value)

/** A caller-supplied service name reduced to the closed-vocabulary shape its class promises. */
export function service(input: string): string {
  const slug = truncate(input.trim().replace(SAFE_SERVICE, "-").replace(/^-+|-+$/g, ""), MAX_SERVICE_CHARS)
  return slug.length === 0 ? "unknown" : slug
}

export interface Extra {
  /** Ready to hand to `Effect.annotateLogs`: every name already namespaced and bounded. */
  readonly annotations: Record<string, string>
  /** Caller fields refused, by count. Reported on the line — a silent drop is a lie by omission. */
  readonly dropped: number
}

/**
 * Namespace, bound and flatten one caller `extra` map.
 *
 * ⚠️ **The prefix is applied to every key without inspecting it**, which is what makes refusal 1
 * total. Checking against `RESERVED_ATTRIBUTES` here would be the *name heuristic* shape this repo
 * has already been burned by; the import exists only so the test can prove the prefix beats the
 * whole reserved set rather than the three names an author happened to think of.
 */
export function extra(input: Readonly<Record<string, unknown>> | undefined): Extra {
  if (input === undefined) return { annotations: {}, dropped: 0 }
  const annotations: Record<string, string> = {}
  let dropped = 0
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(annotations).length >= MAX_EXTRA_KEYS || !SAFE_KEY.test(key)) {
      dropped += 1
      continue
    }
    annotations[`${EXTRA_PREFIX}${key}`] = truncate(render(value), MAX_EXTRA_VALUE_CHARS)
  }
  return { annotations, dropped }
}

/**
 * A caller value as a string. Everything becomes one HERE rather than at the formatter, because the
 * formatter would render a nested object as several dotted columns whose names the caller chose —
 * which is refusals 1 and 2 re-entering through the value side.
 */
function render(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === "object") {
    try {
      return JSON.stringify(value)
    } catch {
      return "[unserializable]"
    }
  }
  return String(value)
}

/**
 * A token bucket, per process, shared by every caller of the route.
 *
 * **Globally, not per client**, on purpose: the budget being protected is one log directory, so a
 * per-caller allowance would multiply by however many clients attach. It is the same "one hand"
 * reasoning principle 9(a) applies to outbound messaging.
 */
export class Limiter {
  private tokens: number
  private last: number
  /** Refused since the last admitted post — carried onto the next line, then reset. */
  private suppressed = 0

  constructor(
    private readonly burst: number = BURST,
    private readonly perSecond: number = PER_SECOND,
    now: number = Date.now(),
  ) {
    this.tokens = burst
    this.last = now
  }

  /** `undefined` when refused; otherwise how many posts were refused since the previous success. */
  admit(now: number = Date.now()): number | undefined {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond)
    this.last = now
    if (this.tokens < 1) {
      this.suppressed += 1
      return undefined
    }
    this.tokens -= 1
    const carried = this.suppressed
    this.suppressed = 0
    return carried
  }
}

/** The instance-wide bucket the handler spends. */
export const limiter = new Limiter()

/** Names the reserved set holds, exported so the guard's test asserts against the real list. */
export const reserved = (): ReadonlyArray<string> => RESERVED_ATTRIBUTES
