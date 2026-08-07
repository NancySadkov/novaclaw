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
 * ⚠️ **`endpoints` is the ONLY field, deliberately.** `locality` and `concurrency` were filed to land
 * here (and, in the original filing, on `ModelV2.Capabilities`). They are not here because neither
 * has a consumer yet: `MAX_BATCH` is a single global constant, there is no KV/VRAM accounting
 * anywhere in the tree, and the scheduler's admit input does not carry a per-device cap across the
 * session-worker protocol. B2's own first step deleted three `SessionConfig` fields for exactly that
 * property — they resolved for nobody — so adding a declared capacity number that nothing reads
 * would re-file the phantom under a new name. They land with the scheduler change that reads them.
 */
export class Info extends Schema.Class<Info>("ConfigV2.Device")({
  /**
   * The endpoint origins this device serves — every model whose `api.url` has one of these origins
   * is scheduled as this one device. Compared after `new URL(…).origin.toLowerCase()`, so a trailing
   * slash, a `/v1` path and case all normalize away; an entry that is not a parsable URL is ignored
   * rather than failing a turn (a malformed registry entry is a config defect, and refusing to
   * schedule would be a worse one).
   */
  endpoints: Schema.Array(Schema.String),
}) {}
