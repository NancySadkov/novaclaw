export * as McpHealthReport from "./health-context"

import { Effect, Layer } from "effect"
import { McpHealthContext } from "@novaclaw/core/mcp-health-context"
import { makeLocationNode } from "@novaclaw/core/effect/app-node"
import { Location } from "@novaclaw/core/location"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { MCP } from "."

// The LIVE READING behind core's `McpHealthContext` seam — the model's half of the 2026-08-07 answer
// to "should a failed MCP server be reported to the model, or to the user?". The decision, the three
// placements it rejects, and the sentences themselves all live at the seam
// (`core/src/mcp-health-context.ts`); this file supplies nothing but the status map.
//
// That map is `MCP.status()` — the SAME one `nova-cli mcp list`, `GET /api/mcp` and the app's status
// popover read. Deriving a second notion of "healthy" here is precisely what would let the model and
// the user be told two different stories about one server.

/**
 * ⚠️ The compile-time link between novaclaw's status union and the seam's bound. If `MCP.Status` ever
 * grows a variant the seam does not know how to describe, this line stops compiling — which is the
 * point. Do not "fix" it by widening the seam's type to `any`-shaped; widen the seam's `lines()` so
 * the new state gets a sentence, or the new state renders empty and ruling 2 is broken again.
 */
const asSeamStatus = (status: MCP.Status): McpHealthContext.ServerStatus => status

export const layer = Layer.effect(
  McpHealthContext.Service,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const location = yield* Location.Service
    // The same minimal instance bridge `mcp/external-tool-source.ts` builds, and deliberately the
    // same `directory`: `InstanceState`'s cache is keyed on it, so this reads the state the tool
    // source already booted rather than starting a SECOND MCP instance — which would spawn a second
    // set of stdio children, per location, per turn.
    const instance = {
      directory: location.directory,
      worktree: location.directory,
      project: {},
    } as unknown as InstanceContext
    return McpHealthContext.Service.of({
      lines: () =>
        mcp.status().pipe(
          Effect.provideService(InstanceRef, instance),
          Effect.map((statuses) =>
            McpHealthContext.lines(
              Object.entries(statuses).map(([name, status]) => ({ name, status: asSeamStatus(status) })),
            ),
          ),
          // The cause is deliberately NOT forwarded to the model: it would name a defect in OUR
          // wiring, and a stack trace is not something a model can act on. The detailed surfaces are
          // unchanged — `nova-cli mcp list`, the status popover, and MCP's own `mcp.server.unavailable`
          // record, which still fires for the underlying server fault.
          Effect.catchCause((): Effect.Effect<ReadonlyArray<string>> => Effect.succeed(McpHealthContext.UNREADABLE)),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: McpHealthContext.Service,
  layer,
  deps: [MCP.node, Location.node],
})
