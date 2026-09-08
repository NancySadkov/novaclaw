export * as McpHealthContext from "./mcp-health-context"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "./effect/app-node"

/**
 * Dependency-inversion seam for **"an MCP server this instance is configured with is not usable"**.
 *
 * The MCP client lives in the novaclaw package; the `<env>` block lives in core. This tiny
 * line-oriented interface is the same shape `resource-pressure-context.ts` uses for the same reason:
 * core states the contract, the outer package injects the one authoritative reading, and neither
 * depends on the other. The default answer below is empty — an instance with no MCP subsystem at all
 * has nothing to report, which is different from *having* one and saying nothing about it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS SEAM EXISTS — the decision, recorded here because the decision is the deliverable
 * (the open question: should a *failed* MCP server be reported to the agent as a missing capability
 * rather than only to the log? — answered 2026-08-07; ruling 2, *an unavailable subsystem names
 * itself instead of rendering empty · a fault is never described falsely*).
 *
 * **Answer: the user AND the model, through different channels, at different pressures.**
 *
 * 1. **The user was already told, and that half needed nothing.** A configured-but-broken MCP server
 *    surfaces on three PULL surfaces that exist today: the titlebar status dot
 *    (`app/src/components/status-popover.tsx` maps `failed` → critical), the per-server row in
 *    `dialog-select-mcp.tsx` — the one place that renders the fault's own `error` string — and
 *    `nova-cli mcp list`, which prints `✗ <name> failed` with the error beneath it. Pull is the right
 *    shape and a push channel would be the wrong one: AGENTS.md's managed-by-default stance is that a
 *    common user is *helped, not handed a pager*, and a toast for a fault nobody can fix mid-turn is a
 *    pager. So nothing is owed to the user here.
 *
 * 2. **The model was told NOTHING, and that is the ruling-2 break.** `MCP.tools()` skips every server
 *    whose status is not `connected`, so a broken server renders as *fewer tools* — indistinguishable
 *    from *never configured*. That is "rendering empty" exactly. The model cannot route around a gap
 *    it cannot see, cannot tell the user which capability it lost, and cannot repair the entry, which
 *    the self-healing law says it must be able to do.
 *
 * 3. **WHERE it is told is the load-bearing half.** Three placements were rejected:
 *    · A per-turn WARN log (today's behaviour) is not a report to anybody — it is the state the
 *      roadmap filed, and the roadmap's own note is that a warning firing every turn trains readers to
 *      skip warnings.
 *    · An unconditional system-prompt section costs prompt tokens forever, on every session, to say
 *      that nothing is wrong. That is the cost the filing warned about.
 *    · A synthetic chat message per turn is worse still: it is per-turn-volatile and lands in the
 *      transcript the user reads.
 *    What ships instead is the shape the tree already uses for degraded capability:
 *    **exception-only ambient context**. `lines()` is EMPTY when every configured server is usable, so
 *    a healthy instance pays **zero** tokens and the composed prompt is byte-identical to one built
 *    with this seam deleted (pinned by `test/system-context/builtins.test.ts`). When something *is*
 *    broken it costs one line per broken server, and it costs it only for as long as the product would
 *    otherwise be silently unable to do what its configuration promises.
 *
 * 4. **It must not invite a retry, and it does not.** The model cannot call the missing tools — they
 *    were never registered — so the line's job is not "try again". It is (a) do not promise a
 *    capability this session does not have, and (b) name where the repair lives.
 *
 * ⚠️ **Volatility.** These lines ride the `<env>` block, which `system-context/builtins.ts` keeps as an
 * Effect precisely so `SystemContext.reconcile` can emit a delta in the message TAIL rather than
 * re-rendering the prompt prefix — see `session/runner/system-compose.ts`'s per-turn-volatility law
 * (one token edited near the front measured 0.3 s → 12.9 s TTFT). A server that flaps therefore costs
 * an update line, never a re-prefill. Do not move this text into a `composeSystemParts` part.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export interface Interface {
  /**
   * Exception-only ambient lines for the model's per-turn environment.
   *
   * 🔴 **Empty is the contract, not a convenience.** Anything that returns a line for a HEALTHY
   * server set converts a zero-token seam into a permanent prompt tax on every session in the
   * product, and it would compile green.
   */
  readonly lines: () => Effect.Effect<ReadonlyArray<string>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/McpHealthContext") {}

// ── the derivation ───────────────────────────────────────────────────────────────────────────────
//
// The SENTENCES live here, with the contract, rather than beside the reading in the novaclaw package
// — for two reasons, and both were paid for:
//
//  1. **The gate must run their check.** `packages/novaclaw/test/mcp/` and `test/` root are
//     `--full`-only run units (`script/test.ts` promotes six subdirs and no others), so a guard placed
//     next to the reading would not execute in `bun run test` — and ruling 1's own words are that a
//     check nobody runs is not a check. `packages/core` is a fast-tier unit.
//  2. **Wording is the contract.** What the model is told is the decision above; where the status is
//     read from is an implementation detail of one runtime. The outer package supplies the reading
//     and nothing else.

/**
 * The status shape this module needs, structurally.
 *
 * ⚠️ **Not a mirror of novaclaw's `MCP.Status` — a BOUND on it.** The outer package assigns its own
 * union into this one, so it is checked by the compiler in the direction that matters: add a status
 * variant there and the assignment stops compiling, which is the failure this file wants. Restating
 * the variants here as an independent copy — the shape that silently drifts — would be the defect
 * `Workspace.layer`'s hand-maintained mirror is on record for.
 */
export type ServerStatus =
  | { readonly status: "connected" }
  | { readonly status: "idle" }
  | { readonly status: "disabled" }
  | { readonly status: "needs_auth" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "needs_client_registration"; readonly error: string }

export interface ServerHealth {
  readonly name: string
  readonly status: ServerStatus
}

/** The longest fault text one line carries. A stdio spawn failure or an OAuth discovery error can run
 *  to several hundred characters of stack-shaped prose; past this the line stops being a report and
 *  starts being a context tax, and the whole detail is one `nova-cli mcp list` away. */
const MAX_ERROR = 160

/**
 * ⚠️ **A status `error` is FOREIGN text and must be flattened.** It is the message of whatever threw
 * inside a third party's transport, so it can carry newlines — and a newline in one of these lines
 * would end the `<env>` block's indented-line structure and read to the model as a new top-level
 * section. Collapse first, truncate second.
 */
export const oneLine = (value: string): string => {
  const flat = value.replace(/\s+/g, " ").trim()
  return flat.length > MAX_ERROR ? `${flat.slice(0, MAX_ERROR)}…` : flat
}

/**
 * The shared closing line. It exists because a bare fault report leaves the model with a problem and
 * no move: this names the two things it can actually do — stop promising the capability, and repair
 * the entry (which the self-healing law says an agent inside the OS must be able to do).
 *
 * ⚠️ It deliberately does NOT say "try again". The tools of an unusable server were never registered,
 * so a retry is not something the model can perform — telling it to would describe the fault falsely.
 */
export const REPAIR_LINE =
  "Do not offer capabilities that depend on the MCP server(s) above; their tools are not loaded in " +
  "this session. Each one's configuration is at mcp.servers.<name> in this instance's settings and " +
  "can be repaired there."

/**
 * The one honest thing to say when the health reading itself fails. Silence here would be this seam's
 * own defect one level up: "the thing that reports unavailability is unavailable" is still an
 * unavailability, and ruling 2 does not exempt it.
 */
export const UNREADABLE = ["MCP server health could not be read for this session."] as const

/**
 * Derive the exception-only lines. `[]` for a healthy set — that is the contract, not a convenience.
 *
 * Which statuses count as a fault:
 *  · `connected` — nothing to say.
 *  · `idle` — configured, but deliberately not materialized until a tool request or explicit
 *    connect action; this is normal optional-capability state, not a fault.
 *  · `disabled` — nothing to say. The user switched this server OFF; naming a deliberate preference
 *    every turn is noise, and ruling 2's own carve-out is that disabled-with-reason stays legitimate.
 *  · `failed` / `needs_client_registration` — a fault, and one that carries its own text.
 *  · `needs_auth` — not a crash, but the capability is just as absent, and its repair is a different
 *    one (sign in, rather than fix the config), so it gets its own sentence.
 *
 * Sorted by name so two consecutive turns over an unchanged server set render byte-identically: an
 * unstable ORDER is indistinguishable from a real change to `SystemContext.reconcile` and would spend
 * an update line per turn saying nothing — the trap `memoryRecall` fell into (see system-compose.ts).
 */
export const lines = (servers: ReadonlyArray<ServerHealth>): ReadonlyArray<string> => {
  const result: string[] = []
  for (const { name, status } of [...servers].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (status.status === "connected" || status.status === "idle" || status.status === "disabled") continue
    if (status.status === "needs_auth") {
      result.push(`MCP server "${name}" is configured but not signed in, so its tools are unavailable this session.`)
      continue
    }
    // A status can be `failed` with an EMPTY error (a transport that rejected with no message), and
    // "unavailable this session: ." would describe the fault falsely by implying we withheld a reason.
    const detail = oneLine(status.error) || "the server reported no reason"
    result.push(
      `MCP server "${name}" is configured but unavailable this session: ` +
        `${/[.!?…]$/.test(detail) ? detail : `${detail}.`}`,
    )
  }
  if (result.length > 0) result.push(REPAIR_LINE)
  return result
}

/** The core default: a runtime with no MCP subsystem reports nothing, because it has nothing to
 *  report. The live reading is injected by the novaclaw server through the location service map. */
export const layer = Layer.succeed(Service, Service.of({ lines: () => Effect.succeed([]) }))

export const node = makeLocationNode({ service: Service, layer, deps: [] })
