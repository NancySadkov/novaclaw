export * as SpawnTool from "./spawn"

import { ToolFailure } from "@novaclaw/llm"
import { SessionType } from "@novaclaw/schema/session-type"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
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
// THE TOOL SURFACE IS THE KERNEL SURFACE, MINUS ONE FIELD. `SpawnInput` (`session/spawner.ts`)
// carries agent · model · systemPromptOverride · type · priority · permissionMode, and the child
// record persists every one of them (`createSessionRecord`, session.ts). All are reachable here
// EXCEPT `priority`: it is a scheduler weight, not a capability the child needs to do its job, and
// unlike `permissionMode` below nothing clamps it against the parent — a model free to set its
// children's priority can outrank the user's own interactive turn on its own say-so. It stays an
// operator-side knob. (Widened 2026-07-28; before that only prompt/agent/systemPromptOverride were
// reachable, so a supervisor could not put a sub-task on a cheaper model or hand it a tighter mode.)
//
// ⚠️ `permissionMode` IS A REQUEST, NEVER A GRANT — and that is what makes widening safe. The
// resolve fold clamps every non-root layer with `moreRestrictive` (`session/config-resolve.ts`), so
// a child can only come back the same or MORE restricted than the chain above it: architecture.md's
// narrowing keystone, and a fork returning LESS restricted than its source is called a defect there,
// not a preference. The row still stores what was asked for — the ECS sparse-override discipline —
// and every consumer (the permission evaluator included) reads it through `resolveSessionConfig`,
// which is where the clamp lives. **Do not re-implement the clamp here**: two seams answering one
// question is ruling 6's forbidden shape, and a second copy is what drifts. Pinned END TO END
// through this tool — real DB, real spawner, real resolve — by `test/spawn-tool-input.test.ts`.

// ─────────────────────────────────────────────────────────────────────────────
// THE MAY-SPAWN GATE — what it buys (gate decided 2026-07-28; the baseline it rests on inverted by
// v0.2.0 B4c).
//
// `spawn` was the one capability-CREATING tool registered with a bare `Tool.make`, and its own TODO
// asked for a gate. It has one now.
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
// So the honest statement, and the one the tests hold to: a default install now ASKS the first time
// a session wants to spawn a helper, the answer is saveable, and a user or an agent config still has
// exactly one place to say otherwise. ⚠️ Two consequences worth naming rather than discovering: an
// UNATTENDED root below `yolo` has nobody to answer, so a scheduled chain that needs sub-agents needs
// the grant saved (or an agent rule) beforehand — the deny-fast stance in `config-resolve.ts` is
// about the external classes, not about this, so an unanswered spawn ask would PARK rather than fail
// fast; and the fork-bomb quotas above remain the real bound either way.
// ─────────────────────────────────────────────────────────────────────────────

export const name = "spawn"

// Field naming follows THIS FILE and its sibling `wait.ts` (`systemPromptOverride`, `sessionID`),
// i.e. camelCase — which is also what most tool inputs use (`patchText`, `oldString`, `replaceAll`,
// `numResults`). `reconfigure`/`register-app` are the two snake_case outliers; the roadmap's
// `permission_mode` spelling would have made this struct disagree with itself.
export const Input = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The task / opening message for the new child agent session." }),
  agent: Schema.String.pipe(Schema.optional).annotate({
    description: 'Optional agent for the child (e.g. "plan", "build"). Omit to inherit this session\'s agent.',
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Optional model for the child, as the full "provider/model-id" (e.g. "dgx-spark/qwen3.6-35b"). ' +
      "Omit to inherit this session's model — use it to put a cheap sub-task on a smaller model.",
  }),
  systemPromptOverride: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional system-prompt override for the child. Omit to inherit this session's prompt.",
  }),
  // The kernel's own literal set, imported rather than retyped: a fifth thread type added to
  // `@novaclaw/schema/session-type` widens this tool in the same commit, with no list to forget.
  type: SessionType.Info.pipe(Schema.optional).annotate({
    description:
      "Optional thread type for the child. Defaults to 'sub-agent' (it works, then waits on you). " +
      "'auto-prompting' keeps prompting itself until it calls exit; 'goal-oriented' loops toward a " +
      "stated goal; 'interactive' blocks for a human.",
  }),
  permissionMode: Schema.Literals(["plan", "ask", "surgical", "bypass", "yolo"])
    .pipe(Schema.optional)
    .annotate({
      description:
        "Optional permission mode for the child, from least to most capable: plan (read only), ask " +
        "(confirm every change), surgical, bypass (act freely inside its folder), yolo. It can only " +
        "RESTRICT the child: a mode more capable than this session's is silently clamped down to this " +
        "session's, never granted. Omit to inherit.",
    }),
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

/**
 * `"provider/model-id"` → the kernel's `ModelV2.Ref`. Rejecting the bare form is not pedantry:
 * `ModelV2.parse("qwen3.6-35b")` yields a ref with an EMPTY model id, the spawn then succeeds, and
 * the fault surfaces minutes later inside the CHILD's first turn where it reads as the child's
 * failure. Ruling 2 — a failed mutation never reports success — so it fails here, in the caller's
 * own tool result, where the caller can still fix it.
 *
 * ⚠️ Known limit, stated rather than hidden: this validates the SHAPE, not existence. The tool has
 * no catalog dependency (and giving it one would pull the model registry into the cycle-free spawn
 * seam), so a well-formed ref naming a model this instance does not serve still fails in the child.
 */
const modelRef = (input: string | undefined): Effect.Effect<ModelV2.Ref | undefined, ToolFailure> => {
  if (input === undefined) return Effect.succeed(undefined)
  const trimmed = input.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1)
    return Effect.fail(
      new ToolFailure({
        message:
          `Invalid model "${input}": give the full "provider/model-id" (e.g. "dgx-spark/qwen3.6-35b"), ` +
          `or omit the field to inherit this session's model.`,
      }),
    )
  const parsed = ModelV2.parse(trimmed)
  return Effect.succeed({ id: parsed.modelID, providerID: parsed.providerID })
}

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
            "inherits this session's agent/model/system-prompt/permissions unless overridden, and carries this " +
            "session as its parent. Returns the child session id. Use it to delegate an independent sub-task.",
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
              // Shape-check the model ref BEFORE the gate: a malformed argument is the caller's
              // mistake, not a denial, and reporting it as one would be the false-fault ruling 2
              // rules out.
              const model = yield* modelRef(input.model)
              // The resource is the child's AGENT — the capability-bearing half of the request and
              // the only field a rule could usefully name ("this session may spawn `plan` helpers
              // but not `build` ones"). "inherit" is the literal resource when the field is
              // omitted, so that case is nameable too instead of matching only `*`.
              yield* permission.assert({
                action: name,
                resources: [input.agent ?? "inherit"],
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
                  agent: input.agent ? AgentV2.ID.make(input.agent) : undefined,
                  model,
                  systemPromptOverride: input.systemPromptOverride,
                  type: input.type,
                  permissionMode: input.permissionMode,
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
