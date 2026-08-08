export * as SessionPlan from "./plan"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { JhEngine } from "../jh/engine"
import type { JhTree } from "../jh/tree"
import type { SessionSchema } from "./schema"
import { SessionComponentTable } from "./sql"
import { SessionComponentRegistry } from "./component-registry"

const planStatus = (status: JhTree.Status): string =>
  status === "committed"
    ? "completed"
    : status === "blocked"
      ? "blocked"
      : status === "expanded"
        ? "in_progress"
        : "pending"

/**
 * Project the harness-owned deep tree into the one shallow plan component set. JH remains the step
 * engine; this is only its user/model-facing ordered view. A verdict appears solely for a committed
 * leaf, after JH's executed check and completion gate have accepted it.
 */
export const projectJh = (
  db: Database.Interface["db"],
  input: {
    readonly sessionID: SessionSchema.ID
    readonly goal: string
    readonly state: JhEngine.State
    readonly now: number
  },
): Effect.Effect<void> =>
  db
    .transaction((tx) =>
      Effect.gen(function* () {
        const leaves = [...input.state.tree.nodes.values()].filter((node) => node.children.length === 0)
        const verified = new Map<string, string>()
        for (const entry of input.state.log)
          if (entry.type === "verification") {
            if (entry.ok) verified.set(entry.step, entry.detail)
            else verified.delete(entry.step)
          }
        yield* tx
          .delete(SessionComponentTable)
          .where(and(eq(SessionComponentTable.session_id, input.sessionID), eq(SessionComponentTable.kind, "plan")))
          .run()
        yield* tx
          .insert(SessionComponentTable)
          .values({
            session_id: input.sessionID,
            kind: "goal",
            component_id: "",
            schema_version: 1,
            lifetime: "entity",
            value: { text: input.goal },
            time_created: input.now,
            time_updated: input.now,
          })
          .onConflictDoUpdate({
            target: [SessionComponentTable.session_id, SessionComponentTable.kind, SessionComponentTable.component_id],
            set: { schema_version: 1, lifetime: "entity", value: { text: input.goal }, time_updated: input.now },
          })
          .run()
        if (leaves.length === 0) return
        yield* tx
          .insert(SessionComponentTable)
          .values(
            leaves.map((node, position) => ({
              session_id: input.sessionID,
              kind: "plan",
              component_id: SessionComponentRegistry.planComponentID(position),
              schema_version: 1,
              lifetime: "entity" as const,
              value: {
                position,
                text: node.draft.goal,
                status: node.status === "committed" && !verified.has(node.id) ? "blocked" : planStatus(node.status),
                verdict:
                  node.status === "committed" && verified.has(node.id)
                    ? {
                        check: JSON.stringify(node.draft.check ?? { type: "artifact_present" }),
                        passedAt: input.now,
                        evidence: verified.get(node.id)!,
                      }
                    : null,
              },
              time_created: input.now,
              time_updated: input.now,
            })),
          )
          .run()
      }),
    )
    .pipe(Effect.orDie)
