export * as ConfigDevice from "./device"

import { Schema } from "effect"

/**
 * A DEVICE — one model backend, declared by the operator (v0.2.0 B2).
 *
 * AGENTS.md's organizing metaphor makes a Device the OS's CPU: model backends, "each tagged with
 * capabilities + locality", and explicitly **not single-threaded**. `session/scheduler.ts` keys its
 * admission gate, its `MAX_BATCH` cap and its EEVDF fairness ledger on a `deviceKey`, so what that
 * key groups IS what the OS believes shares hardware.
 *
 * ⚠️ **Why a declared registry rather than another heuristic.** App `e5c4e4ec6` moved the derived key
 * from `${provider}/${model}` to the model's normalized endpoint ORIGIN, which correctly collapses
 * several models served by ONE process onto one device. It cannot collapse several PROCESSES on one
 * box: `http://host:8010` (vLLM) and `http://host:8011` (llama-server) are two origins and one GPU,
 * so the gate hands out `MAX_BATCH` twice for capacity that exists once — the same oversubscription
 * that fix removed, one layer out. Nothing in a URL says which endpoints share silicon, and the
 * available guess (same hostname ⇒ same machine) is wrong behind any reverse proxy. So the operator
 * says it, once, and `PATCH /config` is where they say it — which is the self-healing law's own
 * shape: an operational fact lives in a runtime-editable store, not compiled in.
 *
 * `concurrency` and `locality` live here, rather than on a model: several models and several endpoint
 * processes may share this one backend. Concurrency is the scheduler's hard generation cap across
 * foreground, background and maintenance work; it is carried on every admission request so a
 * runtime config edit takes effect when the write commits.
 */
export const Locality = Schema.Literals(["local", "lan", "remote"])
export type Locality = typeof Locality.Type

export class Info extends Schema.Class<Info>("ConfigV2.Device")({
  /**
   * The endpoint origins this device serves — every model whose `api.url` has one of these origins
   * is scheduled as this one device. Compared after `new URL(…).origin.toLowerCase()`, so a trailing
   * slash, a `/v1` path and case all normalize away; an entry that is not a parsable URL is ignored
   * rather than failing a turn (a malformed registry entry is a config defect, and refusing to
   * schedule would be a worse one).
   */
  endpoints: Schema.Array(Schema.String),
  /** Maximum concurrent generations across foreground, background, and maintenance work. */
  concurrency: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.optional),
  /**
   * Minimum TIME (ms) a session keeps this device before another agent may take it.
   *
   * ⚠️ This is a cache-affinity control, not a fairness one, and the two are easy to confuse. The
   * scheduler's hard cap protects the backend's MEMORY; this protects its PREFILL. A memory-mapped
   * expert index (the Spark's 44 GiB Flash-Next PLE working set) re-faults from NVMe every time the
   * resident context changes, so ten agents taking turns on one device each pay a full context
   * re-prefill and aggregate throughput collapses to a few token/s even though only one generation
   * is ever in flight. A window measured from each session's last dispatch forms a WARM COHORT: a
   * queued session that ran within the window outranks a cold peer in the next pick, so a looping
   * agent's own turns keep the warm pages instead of evicting them for a newcomer.
   *
   * A preference among waiters, never a reservation: if nobody waiting ran recently the device is
   * handed on normally rather than left idle. 0 (or absent) disables the window entirely and the
   * EEVDF ledger decides, exactly as before.
   */
  minRunMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  /** Where this backend runs relative to the instance. Informational; never inferred from a URL. */
  locality: Locality.pipe(Schema.optional),
}) {}
