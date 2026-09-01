import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

/**
 * ─── THE PRE-ACTION POLICIES INSTALLED IN THIS NOVACLAW ────────────────────────────────────────
 *
 * The gap this closes: *"policies have no management surface … Settings cannot list or toggle them."*
 * This is the list half. The kernel could already refuse, patch, hold and record a tool call; what
 * nobody could do was find out WHICH guards were installed, what each one does, or whether the one
 * their folder asked for is running.
 *
 * ⚠️ **Location-routed, and it has to be.** Half of the answer is a fact about the routed FOLDER —
 * which policy ids its `novaclaw.json` opts into, and whether any of them is missing or switched
 * off, which is the difference between "this folder is governed" and "every tool call in this
 * folder is being refused". An instance-global list could not say either.
 *
 * ⚠️ **It never returns a policy's implementation, only its id and its own one-line description.** A
 * `novaclaw.json` may name a policy and may never carry a command; the same rule holds here, so a
 * client reading this route can render what is installed and can never learn how to author one.
 */

export const InstalledPolicy = Schema.Struct({
  id: Schema.String,
  /**
   * The provider's own sentence about what it does.
   *
   * ⚠️ AUTHOR TEXT. Today only NovaClaw's built-ins register, but `ToolPolicy.Provider` is the
   * interface a plugin implements, so a surface must render this the way it renders a skill's
   * description — sanitized, and never as NovaClaw's own claim.
   */
  describe: Schema.String,
  /**
   * `false` marks a policy a FOLDER opts into by naming it in its `novaclaw.json`.
   *
   * A project may only ever narrow: it can turn an opt-in policy ON for its own folder and can
   * never turn an always-on one off.
   */
  alwaysOn: Schema.Boolean,
  /**
   * `false` marks an ADVISORY policy, whose failure to answer does NOT refuse the call.
   *
   * This is the field that explains why one wedged policy blocks a tool call and another does not,
   * which is otherwise the most confusing thing this subsystem can do to a person.
   */
  safetyCritical: Schema.Boolean,
  /** Whether it is consulted at all — `config.tool_policy.<id>.enabled`. Absent there = `true`. */
  enabled: Schema.Boolean,
}).annotate({ identifier: "InstalledPolicy" })

export const PolicyState = Schema.Struct({
  /** Every policy installed in this instance, sorted by id. */
  installed: Schema.Array(InstalledPolicy),
  /** The ids the routed folder's `novaclaw.json` opts into, verbatim. Empty when it names none. */
  requested: Schema.Array(Schema.String),
  /**
   * Requested ids that are NOT installed here.
   *
   * 🔴 Non-empty means **every tool call in this folder is currently refused**. A requested guard
   * that is missing is not the same as no guard, so the kernel fails closed — and a surface that did
   * not report this would leave a user watching every call fail with no idea why.
   */
  missing: Schema.Array(Schema.String),
  /**
   * Requested ids that ARE installed and have been switched off in Settings.
   *
   * 🔴 Also means every tool call in this folder is refused, and it is reported separately from
   * `missing` because the fix is the opposite one: switch it back on, rather than go and install
   * something.
   */
  disabledButRequested: Schema.Array(Schema.String),
  /** The `novaclaw.json` the requests came from, when a project governs this folder. */
  file: Schema.optional(Schema.String),
}).annotate({ identifier: "PolicyState" })

export const PolicyApi = HttpApi.make("policy").add(
  HttpApiGroup.make("policy")
    .add(
      HttpApiEndpoint.get("list", "/api/policy", {
        query: WorkspaceRoutingQuery,
        success: described(
          PolicyState,
          "The pre-action policies installed here, and what the routed folder asks for",
        ),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "policy.list",
          summary: "List installed pre-action policies",
          description:
            "Every installed policy with its own description, whether it runs by default, whether it fails " +
            "closed, and whether it is switched on — plus the ids this folder's novaclaw.json asks for and " +
            "any of those that are missing or switched off (either of which refuses every tool call here).",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "policy",
        description:
          "Typed pre-action policies: what is installed, what each one does, and what this folder asks for.",
      }),
    )
    // ⚠️ All three, in `experimental.ts`'s order. `InstanceContextMiddleware` is what puts the routed
    // DIRECTORY in scope — without it the handler's `InstanceState.context` dies with "InstanceRef
    // not provided" at runtime while everything typechecks, which is how this route first answered
    // 500 on every read.
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
