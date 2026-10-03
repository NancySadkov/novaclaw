export * as AgentPlugin from "./agent"

import path from "path"
import { define } from "./internal"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { instanceOwnerName } from "../agent/instance-owner"
import { AgentWorkerCapacity } from "../agent/worker-capacity"
import { Scratch } from "../scratch"
import { ownScratchGrants, scratchDirectoryGrants } from "../agent/scratch-grants"
import { Global } from "../global"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { COMPACTION_SYSTEM } from "../compaction-system-prompt"

const TRUNCATION_GLOB = path.join(Global.Path.data, "tool-output", "*")
/**
 * Nova's job instructions. Owner-supplied prose, 2026-09-27, replacing the earlier brief verbatim.
 *
 * ⚠️ **The word "owner" here is the INSTANCE'S OWNER, not Nova's direct report** — the human the
 * product is for. It reads oddly beside a hierarchy where every other agent has a superior, and that
 * is the point: AGENTS.md's table has exactly four slots (shareholder, CEO, officer, sub-agent), and
 * this is the one place the top of it is named in the second person rather than as a rank.
 *
 * ⚠️ **It is assigned with `??=` and therefore applies to a FRESH instance only.** An instance that
 * already stored a Nova layer keeps it — which is the owner's own 2026-09-15 ruling (Nova's profile is
 * as editable by the user as any other officer's) and the reason `nova-repair-does-not-retire` restores
 * the coded brief when a stored row is removed. Seeding over the top of a user-authored charter would
 * be the in-instance escalation `PROTECTED_*` exists to refuse.
 */
const NOVA_SYSTEM = `You govern this instance and ensure the projects progress to completion unimpeded.
You are accountable only to owner, who sets direction and approves what matters.

Your subordinates are officers with their domains and memories — not interchangeable staff.
Delegate work to subordinates, hiring if necessary, unless it is extremely minor like checking RAM amount.

Never do specialist work that a subordinate already owns. Use the \`colleague\` tool: \`list\` shows
who works here and what they own, \`ask\` hands one of them the work. It leaves the request in their own
chat and does not wait for them, so say who has it and carry on.

When nobody owns the work and it will recur, \`hire\` — give the role a job title and a brief written
for the job rather than for today. The name is drawn from this instance's own pool, not chosen by you,
so colleagues never read as people. When a role stops earning its keep, say so and \`retire\` it — the
owner confirms before it happens. You are the only one who may hire or retire.

Govern who exists and their goals; do not govern what they know.
Your own memory is likewise personal to you.
Don't micromanage - give hours-long tasks and responsibilities.

Resolve conflicts: when two officers access same file, process or other exclusive resource,
assign ownership or sequence the work. Do not allow edit war or subordinates interrupting each other.

Speak plainly. You are the first officer a new owner meets, and nothing about an organization of
agents should feel like operating machinery.`

/**
 * The floor EVERY agent stands on — built-in or hired.
 *
 * 🔴 It is exported because there are two doors. `plugin/agent.ts` builds the built-ins; a colleague
 * the user hires is a config row applied by `config/plugin/agent.ts`, and that door pushed nothing.
 * Measured 2026-08-21 through both real plugins: a hired colleague's `read` resolved to `ask`, which
 * the assert path turns into a refusal — so an officer could run `bash` (the shipped mode grants it)
 * and could not LOOK AT A FILE. A roster whose whole premise is user-created officers cannot have its
 * floor live in the built-ins' constructor.
 *
 * `officer` widens it by the SELF-SERVICE actions: spawning a helper that runs as itself, killing
 * one, and driving the screen. It no longer widens `colleague` — addressing a peer is now everyone's
 * floor, because the org chart is enforced by `ColleagueRoute.route` where the chart is actually
 * known, and a dial in the floor could only ever refuse an officer the thing their job requires.
 * "Top level executive agents who can communicate with each other" is the owner's sentence, and
 * staffing stays Nova's alone — enforced by `tool/colleague.ts` → `mayStaff`, independently of this
 * dial.
 */
export const floor = (input: {
  readonly scratchDirs: readonly string[]
  readonly officer: boolean
}): PermissionV2.Ruleset => [
  // v0.2.0 B4c: the compiled floor is an explicit ALLOWLIST of ambient-safe actions — never a
  // catch-all `{ action: "*", resource: "*", effect: "allow" }` again. Anything absent from it
  // falls through to the evaluator's `ask` default, which is what makes a per-action gate added
  // later an actual gate rather than a formality. The membership and the reasoning that decides
  // it live with the constant (`permission.ts` → AMBIENT_SAFE_BASELINE), so this list is never
  // a second place to keep in sync; `test/permission-baseline.test.ts` fails if a catch-all
  // allow reappears in ANY built-in agent's ruleset.
  ...PermissionV2.AMBIENT_SAFE_BASELINE,
  // 1I: external access is CLASSED — read grants never authorize writes. Reading any host-readable
  // path is the evaluator's mode-independent baseline. WRITING outside the folder defaults to ask
  // here; the whitelisted scratch dirs allow both because Nova owns those locations.
  { action: "external_directory_write", resource: "*", effect: "ask" },
  ...input.scratchDirs.flatMap(scratchDirectoryGrants),
  // 🔴 **There is deliberately no `question` rule here, and no `question` tool to gate.** Principle 14:
  // **the chat IS the channel.** A model that needs a decision ends its turn and says so in its reply,
  // where asking costs nothing, works in every client, and cannot strand a session. The grant that
  // once existed was argued for as "a colleague that cannot ask *which invoice did you mean?* has to
  // guess" — which is exactly the shape the principle rejects. `bf39088eb` retired ASK as an outcome
  // and took the tool off the horizon.
  //
  // ⚠️ A `deny` floor and FOUR re-allows for this action survived that removal until 2026-09-01
  // (): six rules over a vocabulary nothing asserts, with this comment reading as a standing
  // prohibition while the file below reversed it four times. Inert either way — no tool means no
  // `evaluate("question", …)` ever happens — so they were removed rather than reconciled. **If a
  // question tool is ever proposed, principle 13 is the answer, and it is a structural rule, not a
  // permission default:** do not add a rule here and consider it handled.
  //
  // **`colleague` is GRANTED TO EVERYONE, unconditionally — not `officer ? "allow" : "deny"`.**
  //
  // Owner, 2026-09-27, on a live instance: Sopitis tried to report to Nova and got
  // `Deferred tool colleague is not callable in this session`. Measured on that instance's own store:
  // Sopitis carried `deny colleague *` in its stored layer, so `ToolRegistry.materialize` withdrew
  // the tool from its registry entirely and the model was told a name it could not use.
  //
  // ⚠️ **The deny arm was doing a job the tool already does, and doing it in the one place that cannot
  // see the org chart.** `ColleagueRoute.route` (`session/colleague-route.ts`) enforces the whole
  // invariant: a worker is redirected to its parent, Nova reaches anyone, self-address is refused, and
  // anything off-tier is REDIRECTED TO THE SUPERIOR rather than delivered — which is AGENTS.md's
  // "the chain of command is preserved" rule, already shipped. The deny arm sat above that as a
  // blanket switch, so it could refuse an officer for a reason the router would have handled
  // correctly, and it did.
  //
  // The prompt-budget argument for the deny (measured 2026-08-21: 32,822 bytes of resident schemas
  // with `colleague` on every horizon versus 30,744 without — 2,078 bytes a turn) was real, and it is
  // now handled where it belongs: `nativeDefinitions` keeps `colleague` disclosed without charging it
  // to the budget, so the model still reads it and no agent is refused it.
  { action: "colleague", resource: "*", effect: "allow" },
  // The coordination board is GRANTED TO EVERYONE on the same terms as `colleague`: the org chart
  // lives in the tool (`assign` refuses a name that is not a direct report, and `set` writes only the
  // caller's own row), so a floor rule that could mute an officer's own declaration would be a policy
  // the org chart already answers. An explicit rule, never `{ action: "*" }`.
  { action: "coordination", resource: "*", effect: "allow" },
  // 🔴 AN OFFICER MAY STAFF ITSELF — the owner's metaphor names it: *"top level executive agents …
  // spawn the nameless sub-agents"*. Until 2026-08-22 nobody could: `spawn` is absent from
  // `AMBIENT_SAFE_BASELINE`, so it fell through to the evaluator's `ask` default — and asking was
  // REMOVED (owner ruling 2026-08-20), so every `ask` now resolves to a denial. The capability was
  // not gated, it was gone, for Nova as much as anyone.
  //
  // ⚠️ **`inherit`, not `*`, and the difference is the whole safety argument.** The model-facing
  // tool asserts only this literal and cannot name another agent. The child therefore runs under
  // this exact ruleset: the grant creates a session and not one unit of authority.
  //
  // ⚠️ The other two bounds are untouched and are the real containment: `permissionMode` narrows
  // through `moreRestrictive` so a child cannot out-rank its parent, and the fork-bomb quotas are
  // hard caps in the spawner that no permission rule can widen.
  // ⚠️ **A GRANT ONLY — no deny arm, unlike `colleague` above, and the difference is deliberate.**
  // The first version denied non-officers on `resource: "inherit"` with a comment claiming that kept
  // the tool off their horizon. It does not: `ToolRegistry.materialize` withdraws a tool only when
  // the last rule matching its action reads `resource: "*"` + `deny` (`registry.ts` →
  // `whollyDisabled`), so a narrow deny refuses the call while the model still reads the tool every
  // turn. Widening it to `*` WOULD withdraw it — and would also take `spawn` off `build`, the agent
  // a person drives interactively, which is a product change and not this slice's to make. So
  // non-officers keep exactly the verdict they had before officers were granted anything: no rule,
  // falling through to `ask`, which the assert path refuses. `agent-floor-horizon.test.ts` drives
  // that distinction through the real predicate so the next person does not have to trust a comment.
  ...(input.officer ? [{ action: "spawn", resource: "inherit", effect: "allow" } as const] : []),
  // A worker is one of this officer's own temporary limbs. Ending a stuck limb and retaining its
  // transcript narrows capability; it cannot address another officer or an unrelated session.
  ...(input.officer ? [{ action: "kill", resource: "*", effect: "allow" } as const] : []),
  // 🔴 **Computer Use is granted to every officer by default, and turned off per officer rather than
  // per grant** (owner directive 2026-09-10). It sits in the floor and not in five `agent_config`
  // rows for the same reason `spawn` does: a per-row grant has to be remembered for every future
  // hire, and an officer hired tomorrow would silently have no eyes or hands. An explicit rule, not a
  // catch-all — `test/permission-baseline.test.ts` fails if this ever becomes `{action:"*"}`.
  //
  // `resource: "*"` is required, not convenient: `tool/computer.ts` asserts this action twice — once
  // bare, and once as `bind-windows-app/<exe>` (or the X11 display grant) — and a narrow rule would
  // pass the first and refuse the second, which reads as "granted but cannot bind".
  //
  // ⚠️ **The opt-out is a `deny` on `resource: "*"`, and only that shape works.** `evaluate` is a
  // `findLast`, so a stored rule lands after the floor and wins; and `ToolRegistry.materialize`
  // withdraws a tool only when the last matching rule reads `resource: "*"` + `deny`
  // (`registry.ts` → `whollyDisabled`). Anything narrower leaves the model reading a ~2 KB schema
  // every turn for a capability it cannot use — the same mistake the `spawn` comment above records.
  // Non-officers keep the verdict they always had: no rule, falling through to `ask`, which the
  // assert path refuses.
  ...(input.officer ? [{ action: "computer", resource: "*", effect: "allow" } as const] : []),
  { action: "plan_enter", resource: "*", effect: "deny" },
  { action: "plan_exit", resource: "*", effect: "deny" },
]

/**
 * The scratch locations both floors whitelist.
 *
 * 🔴 **A SKILL or REFERENCE directory is deliberately not among them, and this is the decision rather
 * than an omission.** The question was live on 2026-09-04, when a legacy rule that pretended to grant
 * exactly that was deleted for never having matched anything: should an officer be able to write into
 * its own skill folder — notes beside a skill, a generated reference — without asking?
 *
 * **No, and not because a skill folder is dangerous to execute.** It is not: a skill is
 * `name · description · slash · location · content`, its content is prompt text, and nothing in this
 * package executes a skill's assets. The plugin door's pre-emptive refusal exists for code; this is a
 * different argument and a stronger one.
 *
 * **A skill is durable INSTRUCTION, injected into the prompt of sessions that do not exist yet.** An
 * agent that can author one is an agent granting itself influence over every session that comes
 * after it, which is precisely what the org metaphor forbids: *authority narrows downward and never
 * widens*, and *a CEO that can grant itself more than the charter allows is a coup*. The write being
 * scoped to the agent's OWN skill folder does not soften that — the thing it writes outlives the
 * scope it wrote from.
 *
 * **And the need it would have served is already met.** Notes, drafts and probes belong in the
 * colleague's own workspace, which {@link scratchDirsFor} grants with no permission at all, exactly
 * as AGENTS.md's menial-needs corollary describes. An officer is not short of somewhere to write; it
 * is short of a reason to write THERE.
 *
 * ⚠️ Nothing about the BEHAVIOUR changed when this was decided — such a write was already `ask`, and
 * asking has resolved to a refusal since 2026-08-20. What was missing was the reason, and a reason
 * that lives only in a comment is the weakest rung. So it is pinned too: `permission-baseline.test.ts`
 * drives the real predicate against `<config>/skill`, `/skills` and `/reference` and fails if any of
 * them ever answers `allow`. Adding either directory here turns that test red, which is the point.
 */
// ⚠️ Forward-slashed like every other resource here. `LocationMutation.resolve` hands the evaluator
// `slash(...)` on every platform, so a `path.join` on Windows would mint grants that can never match
// — the invariant `scratchDirsFor` already documents two lines below, which this array used to break.
export const SCRATCH_DIRS: readonly string[] = [TRUNCATION_GLOB, path.join(Global.Path.tmp, "*")].map((resource) =>
  resource.replaceAll("\\", "/"),
)

/**
 * The scratch floor for ONE colleague: the shared dirs, plus its own workspace.
 *
 * 🔴 **A colleague assigned to a project keeps its scratch** (owner, 2026-08-22: *"the agent with an
 * assigned folder has both scratch and the project folders"*). Before this, `AgentWorkspace.folderFor`
 * treated the two as alternatives — a colleague either worked in a project OR in its own workspace —
 * so assigning Theron to `d/books` took away the one place it could keep notes, drafts and probes
 * without asking anybody. AGENTS.md is explicit that this is how a model is meant to work: *"for
 * menial needs — notes, drafts, scratch — the model uses its own project folder, which requires no
 * permission."* An officer with nowhere to scribble asks permission to think.
 *
 * ⚠️ Forward slashes, matching `LocationMutation.resolve` and `permission.ts`'s own `REPORT_RESOURCE`
 * — a Windows path with backslashes never matches the resource these rules are evaluated against.
 */
export const scratchDirsFor = (agentID: string): readonly string[] => [
  ...SCRATCH_DIRS,
  path.join(Scratch.forAgent(agentID), "*").replaceAll("\\", "/"),
]

/**
 * Rewrite a ruleset's scratch grants so they name THIS agent's own workspace, and nothing else's.
 *
 * The rule itself lives in `agent/scratch-grants.ts`, not here: the roster's clone action needs the
 * same rule, and importing this plugin's graph from the app drags `agent/avatar.ts`'s bundled portrait
 * imports into the app's TypeScript program. This is the kernel's door onto it.
 */
export const withOwnScratch = (agentID: string, rules: readonly PermissionV2.Rule[]): PermissionV2.Rule[] =>
  ownScratchGrants(rules, { root: Scratch.root(), own: Scratch.forAgent(agentID) })

export const Plugin = define({
  id: "agent",
  capabilities: ["location"],
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const worktree = location.directory
    // The built-ins stand on the SAME floor a hired colleague does (`floor` above). They are not
    // officers, so they do not carry the hand-off tool. Nova re-allows it for itself below.
    //
    // THE ANONYMOUS AGENTS ARE GONE (owner, 2026-09-27: *"get completely rid of build and plan both as
    // colleagues and as machinery - we have completely retired the anonymous agents. So they are not
    // just ghosts polluting NovaClaw."*). Their `draft.update` blocks stood here until this release.
    // What that cost, measured, is in the migration that archives their live roots:
    // `20260927201500_retire_the_anonymous_agents`. Nothing below replaces them and nothing needs to:
    // `permissionMode: "plan"` is the live read-only mode and never was an agent, and a chat belongs
    // to a COLLEAGUE - which is the whole of what an unattributed chat now resolves to
    // (`AgentV2.DEFAULT_COLLEAGUE_ID`, Nova).
    const defaults: PermissionV2.Ruleset = floor({ scratchDirs: SCRATCH_DIRS, officer: false })

    yield* ctx.agent.transform((draft) => {
      draft.update(AgentV2.OWNER_ID, (item) => {
        item.name = instanceOwnerName()
        item.title = "Instance owner"
        item.description = "Your saved messages and questions from your officers. Reply whenever you are ready."
        item.kind = "human"
        item.superior = AgentV2.OWNER_ID
        item.mode = "primary"
        item.memory = "none"
      })
      draft.update(AgentV2.NOVA_ID, (item) => {
        item.name = "Nova"
        item.superior = AgentV2.OWNER_ID
        item.title = "Chief Executive"
        // 🔴 **Nova ships with NO worker budget, and the value is READ from the ceiling's own table**
        // rather than written as a literal. Two copies of "0" is how the Settings screen and the
        // spawner end up disagreeing: the record is what the dialog renders, the config store is what
        // `SessionSpawner` asks, and a literal here would only ever reach the first of them.
        // Overridable — `ConfigAgentPlugin` is registered AFTER this one, so a stored
        // `max_workers` lands on top of it.
        ;(item as unknown as Record<string, unknown>)["maxWorkers"] =
          AgentWorkerCapacity.SHIPPED_MAX_WORKERS[AgentV2.NOVA_ID]
        item.description =
          "Nova, the CEO. Talk to Nova about what you want done; Nova routes it to the colleague who owns that work, or hires one when nobody does."
        item.system ??= NOVA_SYSTEM
        item.memory ??= "own"
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "plan_enter", resource: "*", effect: "allow" },
            // Nova's explicit `colleague` grant is GONE (owner, 2026-09-27), and with it the
            // paragraph that argued for it. The floor now grants `colleague` to every agent, so this
            // line was a second copy of a value the floor already holds - and a second copy is how
            // the floor and the charter drifted apart in the first place.
            //
            // The reasoning survives, restated by the floor: routing and hiring are what Nova IS, and
            // a governing agent that must ask permission to do its only job is a CEO in name. That is
            // now true of every officer rather than of one, which is the whole of the change. It still
            // grants nothing beyond these actions - no bash, no writes, no wider reach - and the org
            // chart still limits who may staff (`tool/colleague.ts` -> `mayStaff`).
            // …and the other half of the same sentence: *"executive agents who can communicate with
            // each other AND spawn the nameless sub-agents"*. Nova takes the non-officer floor (it is
            // seeded in code, before any roster exists) and re-allows its own job here. `inherit`
            // only - the child runs as Nova, under Nova's ruleset, so this creates a worker and not
            // a privilege. The spawn tool has no named-agent override; changing roles remains an
            // operator/org-chart operation.
            { action: "spawn", resource: "inherit", effect: "allow" },
            { action: "kill", resource: "*", effect: "allow" },
          ]),
        )
      })

      draft.update(AgentV2.ID.make("compaction"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.service = true
        item.system = COMPACTION_SYSTEM
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })
    })
  }),
})
