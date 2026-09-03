export * as SessionPlan from "./plan"

import { Effect } from "effect"
import type { JhEngine } from "../jh/engine"
import type { JhTree } from "../jh/tree"
import type { SessionSchema } from "./schema"
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
/**
 * Project the JH tree onto the session's `goal` singleton and `plan` set, through the registry
 * (`put` and `replaceSet` validate every row the way any component write is validated). Until
 * 2026-09-03 this was a raw `DELETE … kind = 'plan'` + two `INSERT`s beside `todo.ts`'s own copy of
 * the same SQL, so neither writer's rows were ever checked against `PlanStep`/`Goal`.
 *
 * OWNERSHIP: the `plan` set belongs to whichever planner is ACTIVE — this projection while a strict
 * drain runs the tree, `SessionTodo.update` when the model calls `todowrite`. They cannot be active
 * at once (JH's steps run against JH's own tool table, which has no `todowrite`), so the last
 * writer is the current planner; see the note on `SessionTodo.update`.
 */
export const projectJh = (
  components: SessionComponentRegistry.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly goal: string
    readonly state: JhEngine.State
    readonly now: number
  },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const leaves = [...input.state.tree.nodes.values()].filter((node) => node.children.length === 0)
    const verified = new Map<string, string>()
    for (const entry of input.state.log)
      if (entry.type === "verification") {
        if (entry.ok) verified.set(entry.step, entry.detail)
        else verified.delete(entry.step)
      }
    yield* components.put({ sessionID: input.sessionID, kind: "goal", value: { text: input.goal }, system: true })
    yield* components.replaceSet({
      sessionID: input.sessionID,
      kind: "plan",
      system: true,
      items: leaves.map((node, position) => ({
        id: SessionComponentRegistry.planComponentID(position),
        value: {
          position,
          text: node.draft.goal,
          status: node.status === "committed" && !verified.has(node.id) ? "blocked" : planStatus(node.status),
          verdict:
            node.status === "committed" && verified.has(node.id)
              ? {
                  check: JSON.stringify(node.draft.check ?? { type: "artifact_present" }),
                  passedAt: input.now,
                  // `PlanStep.verdict.evidence` is non-empty by schema. A check can pass with nothing
                  // to quote (an `artifact_present` check has no output), and the raw SQL this
                  // replaced wrote "" — a row `decodeStored` would refuse at the READ; the registry
                  // refuses it at the write, which is the point, so the empty case says what it is.
                  evidence: verified.get(node.id) || "the check passed with no output to quote",
                }
              : null,
        },
      })),
    })
  }).pipe(Effect.orDie)
