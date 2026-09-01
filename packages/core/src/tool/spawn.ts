export * as SpawnTool from "./spawn"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionSpawner } from "../session/spawner"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// Spawn a CHILD session — the OS `fork` (architecture.md Phase 3 step 6). A thin location tool over
// the `SessionSpawner` seam: the child carries this session as its `parentID` (so it inherits
// agent/model/system-prompt/permissions via `resolveSessionConfig` unless overridden), its opening
// prompt is enqueued, and the seam hands it straight to this instance's executor. Guarded by the
// seam's fork-bomb depth/active-fan-out/rate caps (`MAX_SPAWN_DEPTH` 8 · `MAX_SPAWN_CHILDREN` 16 ·
// `MAX_SPAWNS_PER_MINUTE` 10, all enforced in `session/spawner.ts` — the K1 quotas SHIPPED, so no
// TODO here asks for them any more).
//
// ⚠️ The message this tool returns is a CONTRACT with the model, and it was false until B1
// (2026-07-28): it said the child "will run its prompt on the next scheduler cycle" when no
// scheduler cycle existed and the child never ran at all — so a supervisor that dutifully called
// `wait(childID)` burned two minutes and got a timeout, and the fault looked like the model's.
// Ruling 2 pointed at the model instead of the user. Say what is actually true, including the
// `started: false` case: a spawn with no executor attached is a real, durable, NOT-running child.
//
// THE MODEL SURFACE IS A FORK, NOT A SESSION-CREATION FORM. The call is exactly
// `spawn({ prompt })`: agent, model, control binding, system prompt and permission mode inherit; the
// seam supplies `sub-agent` as the thread type. Those fields remain available to operator-side
// session APIs, but advertising them here made a model repeat defaults and manufacture configuration
// it did not need to understand. Every extra argument is another malformed-call frontier.
//
// Permission narrowing remains an OPERATOR concern through `SessionSpawner.SpawnInput`. A model
// spawning a helper expresses only the helper's task. If the parent was explicitly narrowed, the
// child inherits that narrower posture through the parent chain; the model never has to understand
// mode ordering or reproduce a security configuration inside a tool call.

// ─────────────────────────────────────────────────────────────────────────────
// THE MAY-SPAWN GATE — what it buys (gate decided 2026-07-28; the baseline it rests on inverted by
// v0.2.0 B4c).
//
// `spawn` is capability-CREATING even though an inherited child cannot widen authority, so it still
// passes through the agent's staffing rule and the seam's hard quotas.
//
// ✅ **And as of B4c the gate is LIVE rather than inert.** The note that used to stand here said
// that under the default agent baseline — which opened with `{ action: "*", resource: "*", effect:
// "allow" }` — a `permission.assert` resolves to ALLOW, so this gate granted itself. That line is
// gone: `plugin/agent.ts` now opens with `PermissionV2.AMBIENT_SAFE_BASELINE`, and **`spawn` is
// deliberately NOT in it.** Creating a session that carries capability of its own fails the "cannot
// change what a later turn runs" test that constant is written against, and ruling 4's
// *unclassified ⇒ privileged* settles the rest. So spawning now ASKS on a default install, once,
// with a saveable answer — pinned by `test/spawn-tool-input.test.ts` and
// `test/permission-baseline.test.ts`, both negative-controlled against the removed catch-all.
//
// The two arguments below are why the gate was worth adding BEFORE the baseline could carry it, and
// they are kept because they are still the reason it is shaped this way:
//   1. **The action word is not new — it is already live.** `Tool.permission` falls back to the
//      registered tool NAME, so `ToolRegistry.materialize` ALREADY withdraws this tool from the
//      model's horizon for an agent whose rules end in `{ action: "spawn", resource: "*", effect:
//      "deny" }`, and did so before this gate existed. The assert does not mint a promise; it makes
//      an already-honoured action honoured at the granularities `whollyDisabled` cannot express —
//      an `ask`, and a deny scoped to one resource rather than to `*`.
//   2. **Spawn's containment is mechanical and lives elsewhere.** The fork-bomb quotas above are
//      hard caps in the seam; no permission rule can widen them. This gate is a policy hook over an
//      already-bounded capability, not the bound itself.
//
// ⚠️ **THE TWO PARAGRAPHS BELOW USED TO SAY THIS TOOL "ASKS", AND THAT WENT STALE UNDER IT.** They
// described a default install asking once with a saveable answer, and warned that an unattended root
// would PARK on the card. Neither is true since the owner removed asking (2026-08-20): `evaluateInput`
// converts EVERY unresolved `ask` into a denial, attended or not (`permission.test.ts` pins both
// arms). So this gate was not gating spawn — it was abolishing it, for every agent including Nova,
// while the comment here told the next reader a consent card was waiting somewhere.
//
// So the honest statement as of 2026-08-31: an OFFICER may spawn a helper that runs as ITSELF —
// `plugin/agent.ts` grants `{ action: "spawn", resource: "inherit" }`. The model tool cannot name a
// different agent at all; that widening shape belongs to operator-side session creation. The
// fork-bomb quotas above remain the hard bound.
// ─────────────────────────────────────────────────────────────────────────────

export const name = "spawn"

export const Input = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The task / opening message for the new child agent session." }),
})

const StructuredOutput = Schema.Struct({
  childID: Schema.String.pipe(Schema.optional),
  limited: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  message: Schema.String,
})
type Output = typeof Output.Type

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const spawner = yield* SessionSpawner.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Spawn a child agent session (a fork) with its own context that runs the given prompt. The child " +
            "inherits this session's agent, model, system prompt and permission mode. Returns the child session " +
            "id. Use it to delegate an independent sub-task.",
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            ...(output.childID === undefined ? {} : { childID: output.childID }),
            ...(output.limited === undefined ? {} : { limited: output.limited }),
          }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            Effect.gen(function* () {
              // The model-facing fork cannot name another agent, so this resource is always the
              // mechanically safe case: the child inherits this agent and cannot widen authority.
              yield* permission.assert({
                action: name,
                resources: ["inherit"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                },
              })
              return yield* spawner
                .spawn({
                  parentID: context.sessionID,
                  text: input.prompt,
                })
                .pipe(
                  Effect.map(
                    ({ id, started }): Output => ({
                      childID: id,
                      message: started
                        ? `Spawned child session ${id} and started it on the given prompt. It runs independently; ` +
                          `call wait with sessionID "${id}" to block until it finishes and read its result.`
                        : `Spawned child session ${id}, but this instance has no session executor attached, so its ` +
                          `prompt stays queued and it will NOT run — do not wait on it. Do the sub-task here instead.`,
                    }),
                  ),
                  // Fork-bomb guard tripped: inform the model (a denial-as-observation, never a halt).
                  // Caught HERE rather than on the outer pipe so the tagged `SpawnLimitError` never
                  // joins the permission error channel — `catchTag` over a union that also holds a
                  // bare `Error` is the shape that quietly stops narrowing.
                  Effect.catchTag(
                    "SessionSpawner.LimitError",
                    (error): Effect.Effect<Output> =>
                      Effect.succeed({
                        limited: true,
                        message: {
                          depth: `Spawn refused: the session chain is already ${error.depth} deep (max ${error.limit}). Do the sub-task in this session instead of spawning deeper.`,
                          children: `Spawn refused: this session already has ${error.depth} unfinished children (max ${error.limit}). Reuse or wait on existing children instead of spawning more.`,
                          rate: `Spawn refused: ${error.depth} spawns in the last minute (max ${error.limit}). Slow down — wait on the children you already spawned.`,
                          // ⚠️ Says the HOST is short, not that the model misbehaved — the other
                          // three are fork-bomb bounds this session tripped, and telling a model to
                          // "slow down" when the machine is out of memory sends it looking for a
                          // mistake it did not make. Waiting is the action; the children already
                          // running are what will free the room.
                          pressure: `Spawn refused: this machine is low on memory right now, not because of anything you did. Wait for the children you already have to finish, or do the sub-task in this session.`,
                        }[error.reason],
                      }),
                  ),
                )
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                // A denial must reach the model as the DENIAL, not as "unable to spawn" — the
                // deny-fast wording tells an unattended run not to wait for an answer nobody
                // will give (`PermissionV2.denialMessage`).
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                return new ToolFailure({ message: "Unable to spawn child session." })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/spawn",
  layer,
  deps: [ToolRegistry.node, SessionSpawner.node, PermissionV2.node],
})
