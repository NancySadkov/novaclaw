export * as PermissionV2 from "./permission"

import path from "path"
import { makeLocationNode } from "./effect/app-node"
import { Global } from "./global"
import { Context, Deferred, Effect as EffectRuntime, FiberSet, Layer, Schema } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import {
  EFFECTIVE_CONFIG_DEFAULTS,
  MODE_RULES,
  resolveSessionConfig,
  rootSessionType,
  unattendedStanceRules,
  type PermissionMode,
} from "./session/config-resolve"
import { PermissionSaved } from "./permission/saved"
import { SettingsConfigStore } from "./settings-config-store"
import { TRUNCATION_RESOURCE } from "./tool/truncation-dir"

/** Where an Analyze-mode session may still write its report: the app's own temp dir, which the agent
 *  baseline already whitelists for external read/write. Slashed to match `LocationMutation.resolve`. */
const REPORT_RESOURCE = path.join(Global.Path.tmp, "*").replaceAll("\\", "/")

export { Effect, Rule, Ruleset } from "@novaclaw/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionV2.RejectedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

/**
 * Why a denial happened, when the plain rule list would mislead the model. `unattended-confined`
 * = the unattended confinement stance refused an out-of-folder create/modify/read
 * (`config-resolve.ts` → `UNATTENDED_CONFINED_RULES`); the generic wording tells the model to "ask
 * the user to adjust permissions", which is exactly the advice that hangs an unattended run.
 */
export const DenialReason = Schema.Literals(["unattended-confined"])
export type DenialReason = typeof DenialReason.Type

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionV2.DeniedError", {
  rules: Permission.Ruleset,
  reason: DenialReason.pipe(Schema.optional),
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError

/**
 * 1J: lower a permission failure into a model-legible message (denial as observation, never a
 * halt). Tools' blanket `mapError` absorbers call this FIRST, so a denial keeps its identity —
 * including the user's optional reject feedback — instead of collapsing into "Unable to <x>".
 */
export function denialMessage(error: unknown): string | undefined {
  if (error instanceof DeniedError) {
    const denied = error.rules.filter((rule) => rule.effect === "deny")
    const rules = denied.length ? denied : error.rules
    const actions = [...new Set(rules.map((rule) => rule.action))].join(", ") || "unknown"
    const resources = [...new Set(rules.map((rule) => rule.resource))].join(", ") || "unknown"
    // Deny-fast: an unattended run must never be told to "ask the user" — nobody is there, and a
    // model that waits or retries burns the whole run. Name the boundary and the way forward.
    if (error.reason === "unattended-confined")
      return (
        `Permission denied: this is an UNATTENDED session, confined to its own working folder. ` +
        `Creating, modifying or reading anything outside that folder is refused outright (action '${actions}') — ` +
        `no user is present to approve an exception, so waiting or retrying will change nothing. ` +
        `Do the work inside this session's folder instead: relative paths resolve there, and you may create ` +
        `whatever files and subfolders you need. If something outside is genuinely required, finish what you ` +
        `can and name the blocked path in your result.`
      )
    return `Permission denied by policy: action '${actions}' on '${resources}' is not allowed in this mode. Do not retry the same call — work within permitted paths and actions, or ask the user to adjust permissions.`
  }
  if (error instanceof CorrectedError)
    return `The user declined this action and said: "${error.feedback}". Follow the user's direction instead of retrying the same call.`
  if (error instanceof RejectedError)
    return `The user declined permission for this action. Do not retry the identical call. If the task can proceed another way (a different tool, a permitted path, or answering from what you already know), CONTINUE with that approach now; only stop to ask the user when no alternative exists.`
  return undefined
}

export type ReplyVerdict = "allow" | "deny"
export type ReplyScope = "once" | "file" | "always"

/** 1K: normalize the six verdict-scope replies (+ the legacy trio) into {verdict, scope}. */
export function normalizeReply(reply: Reply): { verdict: ReplyVerdict; scope: ReplyScope } {
  switch (reply) {
    case "once":
    case "allow-once":
      return { verdict: "allow", scope: "once" }
    case "always":
    case "allow-always":
      return { verdict: "allow", scope: "always" }
    case "reject":
    case "deny-once":
      return { verdict: "deny", scope: "once" }
    case "allow-file":
      return { verdict: "allow", scope: "file" }
    case "deny-file":
      return { verdict: "deny", scope: "file" }
    case "deny-always":
      return { verdict: "deny", scope: "always" }
  }
}

/**
 * 1K: the resources a reply persists. `file` scope saves the request's CONCRETE resources (this
 * file only); `always` saves the request's broad `save` patterns; `once` persists nothing.
 */
export function savedResources(
  request: { readonly resources: readonly string[]; readonly save?: readonly string[] },
  scope: ReplyScope,
): readonly string[] {
  if (scope === "once") return []
  if (scope === "file") return request.resources
  return request.save ?? []
}

// ⚠️ The `resource` match is only as strong as what `resource` MEANS for that action. For path-shaped
// actions (read/write/external_directory_*) it is a resolved, canonicalized path — a real semantic
// gate. For `bash` the resource is the raw COMMAND STRING, and matching it is a prompt-reduction
// convenience, NOT containment: see the boundary note in `util/wildcard.ts`. Do not add deny-rules
// here expecting them to stop a prompt-injected command; that is the AgentJail program's job.
export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

export const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const settings = yield* SettingsConfigStore.Service
    const pending = new Map<ID, Pending>()

    // Asked/Replied must carry this service's location EXPLICITLY: publishes can run on fibers
    // without Location.Service in context (tool settlement, the session-deleted sweep), and the
    // per-instance /event stream drops location-less events — the CLI deny path hung on exactly
    // that (a runner-origin ask never reached the subscriber).
    const eventLocation: Location.Ref = {
      directory: location.directory,
      ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
    }

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    // Reject every pending ask belonging to a session, publishing Replied so clients clear
    // their stores. Used by the deny-cascade below and by the session-deleted sweep: once the
    // session row is gone the V2 session-scoped reply route can never settle these (it 404s on
    // the missing session), so an orphaned ask would pollute pending lists and attention badges
    // forever with no way to dismiss it.
    const rejectSessionPending = (sessionID: string) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          for (const [id, item] of pending) {
            if (String(item.request.sessionID) !== sessionID) continue
            yield* events.publish(
              Event.Replied,
              {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              },
              { location: eventLocation },
            )
            yield* Deferred.fail(item.deferred, new RejectedError())
            pending.delete(id)
          }
        }),
      )

    // A deleted session takes its pending asks with it. `session.deleted` is the session-level
    // V1 event the engine still emits for every delete (kept through F1g), so this covers both
    // engines with one subscription. A SETTLED DRAIN does too (owner-hit 2026-07-22): the only
    // thing that can consume an answer is the tool awaiting it inside the drain, so once the
    // drain publishes idle/exited (Stop, exit, error — the fiber is gone) every still-pending
    // ask is an orphan. Left alone it wedged the chat permanently: the ask dock replaces the
    // composer while asks are pending, so after an interrupt the user faced stale Allow/Deny
    // buttons with no composer, no Stop, and no way to re-prompt.
    // ⚠️ The sweep must run DETACHED from the publishing fiber: the idle status is published
    // from the interrupted drain's finalizer under `Effect.ignore`, and a listener effect run
    // inline there dies with the fiber and is swallowed (measured live 2026-07-22 — idle on the
    // wire, no Replied). The service-scoped FiberSet runs it on a healthy fiber instead.
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const settledOrphans = (event: { type: string; data: unknown }) => {
      if (event.type === "session.deleted")
        return rejectSessionPending(String((event.data as { sessionID?: string }).sessionID ?? ""))
      if (event.type === "session.status") {
        const data = event.data as { sessionID?: string; status?: { type?: string } }
        if (data.status?.type === "idle" || data.status?.type === "exited")
          return EffectRuntime.sync(() => fork(rejectSessionPending(String(data.sessionID ?? "")))).pipe(
            EffectRuntime.asVoid,
          )
      }
      return EffectRuntime.void
    }
    const unsubscribe = yield* events.listen(settledOrphans)
    yield* EffectRuntime.addFinalizer(() => unsubscribe)

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ origin: location.origin })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: item.effect ?? "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return agent?.permissions ?? missingAgentPermissions
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    // Read from the LIVE store, not a boot-frozen config snapshot, so toggling Paranoid in Settings takes
    // effect on the very next tool call instead of after a restart.
    const paranoid = EffectRuntime.fnUntraced(function* () {
      const all = yield* settings.all().pipe(EffectRuntime.catch(() => EffectRuntime.succeed({})))
      return (all as { paranoid?: unknown }).paranoid === true
    })

    // The whole resolved config, not just the mode: the evaluator also needs the surgical-edits switch.
    const sessionConfig = EffectRuntime.fnUntraced(function* (sessionID: SessionV2.ID) {
      return yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, sessionID, (id) =>
        sessions.get(id as SessionV2.ID),
      )
    })

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      // 1K: the session's resolved permission MODE contributes a rule overlay. Appended after the
      // agent's configured rules (last-match-wins) so the user's explicit mode outranks agent
      // defaults. The early hard-deny check runs over the configured chain and the mode overlay
      // SEPARATELY: combined last-match would let a later non-deny mode rule (ask-mode's `ask`,
      // bypass's `allow`) shadow an explicit configured deny — a mode may convert silent allows
      // into consent or raise defaults, but never soften a deny; and a saved allow-always can
      // never override plan/surgical mode denies.
      const resolved = yield* sessionConfig(input.sessionID).pipe(
        EffectRuntime.catch(() => EffectRuntime.succeed(EFFECTIVE_CONFIG_DEFAULTS)),
      )
      const mode: PermissionMode = resolved.permissionMode
      // Deny-fast — the unattended confinement stance (config-resolve.ts §UNATTENDED CONFINEMENT).
      // Under an UNATTENDED chain ROOT, an out-of-folder create/modify (and its read twin) is
      // refused OUTRIGHT instead of being parked as an ask nobody can answer. Its own HARD arm,
      // checked FIRST, so neither a later mode rule, an agent-level allow-all, nor a saved
      // allow-always can soften it; and TAGGED, so the model gets the unattended wording instead
      // of "ask the user to adjust permissions". Attendance is the ROOT's property (a child cannot
      // declare itself attended out of it) and `yolo` — unreachable for a narrowed child — is the
      // one deliberate way out.
      const rootType = yield* rootSessionType(input.sessionID, (id) => sessions.get(id as SessionV2.ID)).pipe(
        EffectRuntime.catch(() => EffectRuntime.succeed(EFFECTIVE_CONFIG_DEFAULTS.type)),
      )
      // ...with ONE exemption: the managed tool-output store. A tool whose output is too large is spilled
      // to `<data>/tool-output/` and the model is told to go read it — but that store sits outside every
      // Location, so inspecting it classifies as an external-directory READ and the blanket deny above
      // would cut an unattended agent off from its OWN output (the default allow rule for this store,
      // installed in agent.ts, cannot help: the hard arm is checked before any allow is consulted).
      // Appended AFTER the denies deliberately — `evaluate` resolves by findLast, so the narrower allow
      // wins for this resource only. This exemption grants nothing the attended default did not already.
      const isParanoid = yield* paranoid()
      const stanceRules = unattendedStanceRules(rootType, mode, isParanoid)
      const stance =
        stanceRules.length === 0
          ? stanceRules
          : [...stanceRules, { action: "external_directory_read", resource: TRUNCATION_RESOURCE, effect: "allow" as const }]
      const configuredRules = yield* configured(input.sessionID, input.agent)
      // The mode overlay, plus Analyze's one carve-out. "Analyze" (mode `plan`) is read-only EXCEPT that it
      // may still write its findings somewhere — a review that cannot save its own report is not much use.
      // The allows land AFTER the mode denies (findLast) so they apply to the temp dir and nowhere else, and
      // they are folded into the same array the early deny-fast arm checks, or that arm would refuse the
      // write before ever seeing the exception.
      const modeRules =
        mode === "plan"
          ? [
              ...MODE_RULES[mode],
              { action: "create", resource: REPORT_RESOURCE, effect: "allow" as const },
              { action: "write", resource: REPORT_RESOURCE, effect: "allow" as const },
              { action: "edit", resource: REPORT_RESOURCE, effect: "allow" as const },
              { action: "external_directory_write", resource: REPORT_RESOURCE, effect: "allow" as const },
            ]
          : MODE_RULES[mode]
      // The two Tuning switches that were once modes. Both NARROW whatever mode is active and never widen
      // it, so they sit after the mode overlay and are included in the deny-fast arm below. Both default
      // OFF (no global `{ enabled }` block to inherit from), which is why absent means "do not apply".
      const featureRules: Permission.Ruleset = [
        // "Edits instead of overwriting": a full-file `write` is refused; `edit`/`create` still work.
        ...(resolved.surgicalEdits === true
          ? [{ action: "write", resource: "*", effect: "deny" as const }]
          : []),
        // "Ask before every change": the old `ask` mode's overlay, now composable with Analyze or Build.
        ...(resolved.askBeforeChanges === true
          ? ([
              { action: "edit", resource: "*", effect: "ask" },
              { action: "write", resource: "*", effect: "ask" },
              { action: "create", resource: "*", effect: "ask" },
              { action: "trash", resource: "*", effect: "ask" },
              { action: "bash", resource: "*", effect: "ask" },
            ] as Permission.Ruleset)
          : []),
      ]
      // READ BASELINE. Reading outside the project folder is ordinary work — a toolchain, an SDK, a system
      // header — so the default is ALLOW and it sits at the LOWEST precedence, where anything more specific
      // overrides it. Writing outside is untouched here and keeps its own `ask` default: the risk this whole
      // stack exists to answer is a destructive WRITE, not a read.
      //
      // Under Paranoid the same default flips to `ask`, but it cannot simply sit at the bottom: rules
      // resolve by ORDER alone (findLast), and the agent baseline opens with a catch-all `* → allow` that
      // would swallow it. So the Paranoid rule is appended AFTER the configured rules to beat catch-alls —
      // yet skipped entirely when a rule SPECIFIC to this resource already governs it, because such a rule
      // IS the explicit permission Paranoid is asking for. Saved "always allow" answers are applied later
      // still, so answering the ask once ends it for that path.
      const readAction = "external_directory_read"
      const governedSpecifically = (resource: string) =>
        configuredRules.some(
          (rule) =>
            rule.resource !== "*" &&
            Wildcard.match(readAction, rule.action) &&
            Wildcard.match(resource, rule.resource),
        )
      const readBaseline: Permission.Ruleset = isParanoid
        ? []
        : [{ action: readAction, resource: "*", effect: "allow" }]
      const paranoidRead: Permission.Ruleset =
        isParanoid && !input.resources.every(governedSpecifically)
          ? [{ action: readAction, resource: "*", effect: "ask" }]
          : []
      const rules = [...readBaseline, ...configuredRules, ...paranoidRead, ...modeRules, ...featureRules, ...stance]
      if (denied(input, stance))
        return { effect: "deny" as const, rules, reason: "unattended-confined" as DenialReason | undefined }
      if (denied(input, configuredRules) || denied(input, modeRules) || denied(input, featureRules))
        return { effect: "deny" as const, rules, reason: undefined as DenialReason | undefined }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      return { effect, rules: all, reason: undefined as DenialReason | undefined }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request, { location: eventLocation })
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new DeniedError({
              rules: relevant(input, result.rules),
              ...(result.reason ? { reason: result.reason } : {}),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                // The awaiting tool is going away — settled or INTERRUPTED (Stop). An entry
                // still pending here means nobody replied, so tell every client the ask is
                // dead (Replied/reject), or the ask dock wedges on a stale card with the
                // composer gone (owner-hit 2026-07-22). Detached via the service FiberSet:
                // this finalizer runs on the dying drain fiber, where an inline publish dies
                // with the fiber and is silently swallowed. (A settled reply deletes the
                // entry first, so this publishes nothing on the normal path.)
                if (pending.delete(item.request.id))
                  fork(
                    events
                      .publish(
                        Event.Replied,
                        {
                          sessionID: item.request.sessionID,
                          requestID: item.request.id,
                          reply: "reject",
                        },
                        { location: eventLocation },
                      )
                      .pipe(EffectRuntime.asVoid),
                  )
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(
            Event.Replied,
            {
              sessionID: existing.request.sessionID,
              requestID: existing.request.id,
              reply: input.reply,
            },
            { location: eventLocation },
          )

          const { verdict, scope } = normalizeReply(input.reply)
          const persisted = savedResources(existing.request, scope)

          if (verdict === "deny") {
            // 1K: a deny can persist (file/always scope) so the same ask never comes back.
            if (persisted.length)
              yield* saved.add({
                origin: location.origin,
                action: existing.request.action,
                resources: persisted,
                effect: "deny",
              })
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
            )
            pending.delete(input.requestID)
            // The deny cascades: the session's other queued asks reject too.
            yield* rejectSessionPending(String(existing.request.sessionID))
            return
          }

          if (persisted.length) {
            yield* saved.add({
              origin: location.origin,
              action: existing.request.action,
              resources: persisted,
              effect: "allow",
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (!persisted.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            const input = { ...item.request }
            const rules = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rules) continue
            if (denied(input, rules)) continue
            const effective = [...rules, ...rememberedRules]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
            yield* events.publish(
              Event.Replied,
              {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "always",
              },
              { location: eventLocation },
            )
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node, SettingsConfigStore.node],
})
