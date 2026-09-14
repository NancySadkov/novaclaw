export * as AgentV2 from "./agent"

import { makeLocationNode } from "./effect/app-node"
import { Array, Context, Effect, Layer, Types } from "effect"
import { Agent } from "@novaclaw/schema/agent"
import { State } from "./state"

export const ID = Agent.ID
export type ID = typeof ID.Type
/**
 * The BUILD agent's id. Named for what it is, not for a role it no longer has: it was
 * `defaultID` while an unattributed chat ran as `build`, and one name for two ideas is how the
 * plugin's "configure the build agent" call and the runner's "who owns this chat" call drifted
 * into each other.
 */
export const BUILD_ID = ID.make("build")

/**
 * @deprecated Use {@link BUILD_ID} for the build agent, or {@link DEFAULT_COLLEAGUE_ID} for the
 * officer an unattributed chat belongs to. Kept so an out-of-tree caller keeps compiling.
 */
export const defaultID = BUILD_ID

/** The CEO of this instance's organization (AGENTS.md — the structural metaphor). */
export const NOVA_ID = ID.make("nova")

/**
 * 🔴 **WHO OWNS A CHAT NOBODY ATTRIBUTED — and it is an OFFICER, never a posture.**
 *
 * Owner, 2026-08-24: *"ensure there are no such ghost officers, and instead the [bar] at the bottom
 * defaults to Nova itself, while the user can only speak with the officers, which are fully
 * responsible for their subagents."*
 *
 * This used to be `build`, which produced the haunting the owner named: the agent that answered you
 * had no Contacts row (`POSTURE_IDS` excludes it from `isColleague`), was exempt from one-chat-per-
 * agent, and therefore never got the identity that would title its chat — so the chat stayed *"New
 * session"* and the thing you were talking to did not appear to exist. AGENTS.md's own table has no
 * slot for a posture: it is shareholder, CEO, officer, sub-agent. `build` is a permission mode, and
 * a permission mode is not someone you can talk to.
 *
 * Nova specifically, because the CEO is the one who *"routes a task to the right agent"* — an
 * unattributed request is exactly the case the CEO exists to absorb.
 */
export const DEFAULT_COLLEAGUE_ID = NOVA_ID

/**
 * 🔴 **NAMED SERVICE AGENTS — the subsystems that start work of their own.**
 *
 * Owner, 2026-08-28: *"if something needs special treatment, it needs a service/system agent, which
 * can be named and pointed at. If we need to process multiple instance of that item at once, we just
 * tell that agent to spawn sub agents. TLDR: no ghosthouse architecture."*
 *
 * The messenger gateway and the recipe cook used to create sessions with NO agent at all — rows that
 * belonged to nobody, appeared on no roster, and could be reached from nowhere. That is the same
 * haunting `DEFAULT_COLLEAGUE_ID` was written to end, arriving through a different door: a machine
 * one instead of the composer.
 *
 * ⚠️ They are HIDDEN, not secret. A hidden agent still has a name, a title and a Contacts row under
 * "Hidden" — so the thing that started a chat can be pointed at, which is the whole difference
 * between a service and a ghost.
 *
 * ⚠️ **Many at once become CHILDREN, never siblings.** One live root per agent is enforced in the
 * database, so a second messaging account cannot be a second messenger root. It is a sub-session of
 * the messenger's own chat — which is what "tell that agent to spawn sub agents" means, and it is
 * how the fleet already works everywhere else.
 */
export const MESSENGER_ID = ID.make("messenger")
export const RECIPE_ID = ID.make("recipe")

/** Agent ids the user may not delete through any surface.
 *
 *  🔴 Nova is on this list because the tree root cannot be deleted without deleting the tree. The
 *  protection is enforced where the LIFECYCLE happens (`DELETE /api/agent/:id`, `planClone`), never
 *  merely hidden in the UI, because the UI is not the only door.
 *
 *  ⚠️ **This is a floor under the org chart, not a lock on the user's own instance.** Owner ruling,
 *  2026-09-15: *"ensure Nova's profile is as editable by user as any other officer, except user
 *  can't assign Nova a project folder, clone or retire Nova — just like the tree root can't be
 *  deleted without the entire instance of the tree."* So Nova's PROFILE is the user's to shape,
 *  exactly as every other officer's is; what stays fixed is that Nova exists (no retirement), that
 *  it stays the one CEO (no clone), and that it governs from the instance rather than from a project
 *  folder ({@link PROTECTED_NEVER}). */
export const PROTECTED_IDS: ReadonlySet<string> = new Set([NOVA_ID])

export const isProtected = (id: string): boolean => PROTECTED_IDS.has(id)

/**
 * Who is writing a config fragment.
 *
 * 🔴 **The distinction is the whole protection, and it is a REAL boundary rather than a courtesy.**
 * AGENTS.md's *"the charter is not editable from inside"* is about a stray prompt neutering the
 * instance's governing agent — an agent reaching the config store through its own `configure` tool,
 * or third-party plugin code calling `ConfigStoreWrite.apply` in process. The operator at the UI is
 * a different actor: they own the instance, and the shareholder's right to shape their own org chart
 * is not the threat the rule exists for.
 *
 *  · `"operator"` — a person driving a NovaClaw surface. Reaches config only over HTTP, with the
 *    instance's own credentials, which nothing hands to a session (`tool/configure.ts` header).
 *  · `"instance"` — anything running inside the instance: the `configure` tool, a plugin, an
 *    in-process caller. This is the DEFAULT, so a new caller that forgets to say who it is gets the
 *    untrusted arm rather than the privileged one.
 */
export type ConfigWriter = "operator" | "instance"

/**
 * The CLOSED vocabulary of config fields an IN-INSTANCE writer may set for a protected agent.
 *
 * An agent editing config on the user's behalf must not be able to rewrite the governing agent's
 * brief, model, permissions or prompts: that is the stray-prompt escalation AGENTS.md names. It was
 * enforced by dropping a stored `nova` layer WHOLE, which also silently swallowed two knobs that are
 * not the charter at all — whether Nova captions its shell commands, and whether Nova keeps
 * memories. Both are components on the ECS lens (AGENTS.md, the structural metaphor), not governing
 * agent redefinition — neither grants a capability, alters a prompt, nor touches who exists.
 *
 * So the rule is: an in-instance fragment naming Nova may carry these keys and nothing else. Closed
 * rather than "everything except the dangerous ones", for the reason principle 13 gives — an open
 * vocabulary is the charter with extra steps, and an exclusion list is only as good as whoever last
 * imagined the threat. Adding a key here is a security decision, not a convenience: it must not be
 * able to widen what Nova can do or rewrite what Nova is told.
 *
 * ⚠️ `memory` is here because keeping-or-not-keeping memories is the user's call about their own
 * machine, not a property of the charter. Turning it off costs Nova its recall; it grants nothing.
 *
 * ⚠️ The operator's arm is NOT this set — see {@link protectedRefusedKeys}. A write from the user's
 * own surface carries the whole officer profile, which is what makes Nova as editable as any other
 * colleague.
 */
export const PROTECTED_TUNABLE: ReadonlySet<string> = new Set(["memory", "toolLabels"])

/**
 * Keys NOBODY may set on a protected agent, whoever is writing.
 *
 * The tree root does not live in a folder. Nova governs from the instance, and `directory` is the one
 * profile field that would move its working root onto a project the user picked — which is the
 * exception the owner named explicitly alongside retirement and cloning. Everything else in the
 * officer profile is editable.
 *
 * ⚠️ `""` is refused too, and that is not an accident: the field's own contract is "unset means the
 * agent's scratch", so an empty string is how the UI clears it. Nova never has one to clear.
 */
export const PROTECTED_NEVER: ReadonlySet<string> = new Set(["directory"])

/** Which of {@link PROTECTED_TUNABLE} a fragment actually carries. Empty = it carries only charter. */
export const protectedTunableKeys = (fragment: Record<string, unknown>): string[] =>
  Object.keys(fragment).filter((key) => PROTECTED_TUNABLE.has(key))

/**
 * Which keys of a fragment naming a protected agent this rule refuses.
 *
 * ⚠️ `writer` DEFAULTS TO `"instance"`, the narrow arm. A caller that does not know who it is is
 * not the operator, and the safe answer has to be the one you get by doing nothing.
 */
export const protectedRefusedKeys = (
  fragment: Record<string, unknown>,
  writer: ConfigWriter = "instance",
): string[] =>
  Object.keys(fragment).filter(
    (key) => PROTECTED_NEVER.has(key) || (writer !== "operator" && !PROTECTED_TUNABLE.has(key)),
  )

/**
 * May this agent STAFF the roster — hire and retire?
 *
 * 🔴 The CEO's alone (AGENTS.md — the structural metaphor: Nova "creates the role when none exists,
 * and retires one that no longer earns its keep"). An officer that could hire would be a second CEO,
 * and an org with two CEOs has none.
 *
 * ⚠️ It lives HERE, beside `isProtected`, rather than in `tool/colleague.ts` where it started —
 * because the tool is not the only door. The tool runs INSIDE THE WORKER, so its check is the
 * worker's own; the host reaches `ColleagueHandoff.hire` on the worker's word and needs the same
 * rule without importing the tool (which imports the handoff, and would close a cycle).
 *
 * ⚠️ Enforced as WELL as by permission rules, and the two are not redundant. A rule is the operator's
 * dial and can be widened; this is the org chart itself.
 */
export const mayStaff = (agentID: string | undefined): boolean => agentID === NOVA_ID

/**
 * Does this agent hold the instance's full charter?
 *
 * Owner, 2026-09-02: *"Nova itself should have full permission for everything… i.e. it lacking
 * permission is not an option."* Nova is the CEO in AGENTS.md's structural metaphor, and authority
 * narrows DOWNWARD from it — so a rule that narrows the top has inverted the org chart. A CEO that
 * has to ask its own instance for consent is not a CEO.
 *
 * ⚠️ Beside `mayStaff` and `isProtected` on purpose: these are the ORG CHART, enforced as well as by
 * permission rules and not redundant with them. A rule is the operator's dial and can be widened or
 * narrowed; this is the shape of the organization and is neither.
 *
 * ⚠️ It is an authority floor, NOT a bypass of every gate in the product. The plugin door
 * (`permission.ts`) stays shut for Nova too, and deliberately: that gate is not a permission tier,
 * it is the one place in-process third-party code can enter, and `import()` runs module scope before
 * anything validates it. No authority level was ever meant to open it — a Nova carrying an injected
 * instruction is exactly the case it exists for. Everything a colleague could be granted, Nova has.
 */
export const hasFullAuthority = (agentID: string | undefined): boolean => agentID === NOVA_ID

/** Resolve one reporting line against the live roster. Invalid, missing, self-referential and cyclic
 * lines all fall back to Nova, so imported config cannot turn the chain of command into a loop. */
export const resolveSuperior = (
  selfID: string,
  configured: string | undefined,
  roster: ReadonlyArray<Info>,
): Info | undefined => {
  if (selfID === NOVA_ID) return undefined
  const byID = new Map(roster.map((agent) => [String(agent.id), agent]))
  const fallback = byID.get(NOVA_ID)
  const requested = configured ?? NOVA_ID
  if (requested === selfID) return fallback
  const superior = byID.get(requested)
  if (superior === undefined || !isColleague(superior) || superior.paused === true) return fallback
  const seen = new Set([selfID])
  let cursor: Info | undefined = superior
  while (cursor !== undefined && String(cursor.id) !== NOVA_ID) {
    const id = String(cursor.id)
    if (seen.has(id)) return fallback
    seen.add(id)
    cursor = byID.get(String(cursor.superior ?? NOVA_ID))
    if (cursor === undefined || cursor.paused === true) return fallback
  }
  return superior
}

/**
 * The POSTURE agents. `build` and `plan` are permission modes wearing an agent's shape (owner,
 * 2026-08-22), not people — and `build` is this instance's DEFAULT agent (see `defaultID` above), so
 * an ordinary chat that never named a colleague still carries `agent: "build"` on its row.
 */
export const POSTURE_IDS: ReadonlySet<string> = new Set([ID.make("build"), ID.make("plan")])

/**
 * Is this a COLLEAGUE — someone on the roster — rather than staff, machinery, or a posture?
 *
 * 🔴 Lives in the kernel because a KERNEL invariant depends on it: one chat per colleague, enforced
 * at `createSessionRecord`. The app has the same predicate at `apps/contacts.ts:isColleague`, whose
 * comment calls itself "ONE choke point on purpose" — it now reads this, so there is one definition
 * rather than two that drift.
 *
 * ⚠️ The posture clause is not cosmetic, and it was measured. Keyed on `agent !== undefined` alone,
 * the one-chat guard would have collapsed **54 live `build` chats into one** on the owner's own
 * installed instance (scanned 2026-08-23: `build` 54, `nova` 2). `agent` on a session row means
 * "the agent this session RUNS AS", which defaults to `build` — it does not mean "this is a
 * colleague's chat".
 */
export const isColleague = (agent: {
  readonly id: string
  readonly mode?: string
  readonly hidden?: boolean
}): boolean => agent.mode !== "subagent" && !agent.hidden && !POSTURE_IDS.has(agent.id)

export const Color = Agent.Color

export const Info = Agent.Info
export type Info = Agent.Info

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

type Data = {
  agents: Map<ID, Types.DeepMutable<Info>>
  default?: ID
}

export type Draft = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly default: () => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID | string) => Effect.Effect<Selection>
  readonly all: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Agent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Data, Draft>({
      initial: () => ({ agents: new Map() }),
      draft: (draft) => ({
        list: () => Array.fromIterable(draft.agents.values()) as Info[],
        get: (id) => draft.agents.get(id),
        default: (id) => {
          draft.default = id
        },
        update: (id, fn) => {
          const current = draft.agents.get(id) ?? (Info.empty(id) as Types.DeepMutable<Info>)
          if (!draft.agents.has(id)) draft.agents.set(id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          draft.agents.delete(id)
        },
      }),
    })
    // ⚠️ `paused` excluded here but NOT from `isColleague`: a paused colleague still belongs on the
    // roster (that is the whole point of pausing rather than retiring), it simply must never be the
    // agent a session falls back to when nothing else is chosen.
    const selectable = (agent: Info | undefined) =>
      agent && agent.mode !== "subagent" && !agent.hidden && agent.paused !== true ? agent : undefined
    /**
     * 🔴 An unattributed chat belongs to an OFFICER. See {@link DEFAULT_COLLEAGUE_ID} for why.
     *
     * ⚠️ The posture clause applies to the CONFIGURED default too, not only to the fallback. A
     * `default_agent: "build"` in config is the ordinary state of an instance that predates this
     * ruling — honouring it would leave exactly the installs the owner is complaining about
     * unchanged, which is the whole failure mode of a rule that only guards the new path.
     */
    const selectedOfficer = (agent: Info | undefined) => (agent && isColleague(agent) ? selectable(agent) : undefined)
    const selectedDefault = () => {
      const data = state.get()
      const configured = data.default ? selectedOfficer(data.agents.get(data.default)) : undefined
      if (configured) return configured
      const nova = selectedOfficer(data.agents.get(DEFAULT_COLLEAGUE_ID))
      if (nova) return nova
      // ⚠️ Still an officer, never a posture: an instance whose Nova is paused falls to another
      // colleague rather than back to `build`, because a posture answering the user is the defect.
      for (const agent of data.agents.values()) {
        const fallback = selectedOfficer(agent)
        if (fallback) return fallback
      }
      // Last resort only: nothing colleague-shaped exists at all (a degraded or mid-boot registry).
      // Better a posture answers than nothing does — but it is the floor, not the preference.
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("AgentV2.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      default: Effect.fn("AgentV2.default")(function* () {
        return selectedDefault()
      }),
      resolve: Effect.fn("AgentV2.resolve")(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault()
      }),
      select: Effect.fn("AgentV2.select")(function* (id) {
        if (id !== undefined) {
          const selected = ID.make(id)
          return { id: selected, info: state.get().agents.get(selected) }
        }
        const info = selectedDefault()
        return { id: info?.id ?? DEFAULT_COLLEAGUE_ID, info }
      }),
      all: Effect.fn("AgentV2.all")(function* () {
        return Array.fromIterable(state.get().agents.values())
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [] })
