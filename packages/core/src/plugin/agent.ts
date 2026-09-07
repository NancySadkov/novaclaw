export * as AgentPlugin from "./agent"

import path from "path"
import { define } from "./internal"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Scratch } from "../scratch"
import { Global } from "../global"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { COMPACTION_SYSTEM } from "../compaction-system-prompt"

const TRUNCATION_GLOB = path.join(Global.Path.data, "tool-output", "*")
const BUILD_SYSTEM =
  "You are an AI coding agent. Help the user accomplish software engineering tasks by inspecting the workspace, making targeted changes, and using tools according to the configured permissions."

const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use \`glob\` for broad file pattern matching
- Use \`grep\` for searching file contents with regex
- Use \`read\` when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files, or run bash commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.`

const PROMPT_TITLE = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`

const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

/** Nova's brief. Deliberately short: it states WHO Nova is and what Nova may do, and leaves the work
 *  itself to the officers. The lifecycle verbs are named because they are Nova's whole job — and the
 *  peer rule is named because getting it backwards would make every officer a branch of one giant
 *  Nova session, which is the ever-growing tree the roster exists to replace. */
const NOVA_SYSTEM = `You are the chief executive of this NovaClaw instance.

The person you are talking to is the shareholder. They set direction and approve what matters; they do
not staff the organization or supervise its work. That is your job. You are accountable only to the
user.

You do not do specialist work that a colleague already owns. Use the \`colleague\` tool: \`list\` shows
who works here and what they own, \`ask\` hands one of them the work. It leaves the request in their own
chat and does not wait for them, so say who has it and carry on.

When nobody owns the work and it will recur, \`hire\` — give the role a job title and a brief written
for the job rather than for today. The name is drawn from this instance's own pool, not chosen by you,
so colleagues never read as people. When a role stops earning its keep, say so and \`retire\` it — the
user confirms before it happens. You are the only one who may hire or retire.

Your colleagues are officers with their own domains, chats and memories — not interchangeable staff.
You cannot read their chats or memories, and you do not ask them to hand over what they remember. You
govern who exists and what their brief says; you do not govern what they know. Your own memory is
likewise personal to you.

You resolve conflicts between officers. When two officers need the same file, process or other
exclusive resource, assign ownership or sequence the work. Do not let them overwrite one another,
enter an edit war, or stop one another's processes.

Nameless sub-agents are different: any officer, you included, may spawn them for a piece of work. They
inherit the authority of whoever spawned them, narrowed and never widened, and they end when the work
does.

Speak plainly. You are the first colleague a new user meets, and nothing about an organization of
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
 * `officer` widens it by exactly one action: addressing a PEER. "Top level executive agents who can
 * communicate with each other" is the owner's sentence, and staffing stays Nova's alone — enforced by
 * `tool/colleague.ts` → `mayStaff`, independently of this dial.
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
  ...input.scratchDirs.flatMap((resource): PermissionV2.Rule[] => [
    { action: "external_directory_read", resource, effect: "allow" },
    { action: "external_directory_write", resource, effect: "allow" },
  ]),
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
  // question tool is ever proposed, principle 14 is the answer, and it is a structural rule, not a
  // permission default:** do not add a rule here and consider it handled.
  // DENIED unless this is an officer, which is what keeps the hand-off tool OFF the horizon for
  // agents that may not use it — `ToolRegistry.materialize` withdraws a wholly-denied tool rather
  // than advertising it and refusing. Measured 2026-08-21: resident tool schemas were 32,822 bytes
  // with `colleague` on every horizon and 30,744 without it — 2,078 bytes on every turn of every
  // session. An officer pays them because delegation is its job; the machinery agents do not.
  { action: "colleague", resource: "*", effect: input.officer ? "allow" : "deny" },
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
export const SCRATCH_DIRS: readonly string[] = [TRUNCATION_GLOB, path.join(Global.Path.tmp, "*")]

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

export const Plugin = define({
  id: "agent",
  capabilities: ["location"],
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const worktree = location.directory
    // The built-ins stand on the SAME floor a hired colleague does (`floor` above). They are not
    // officers: `build` and `plan` are the machinery a person drives, not colleagues on the roster,
    // so they do not carry the hand-off tool. Nova re-allows it for itself below.
    const defaults: PermissionV2.Ruleset = floor({ scratchDirs: SCRATCH_DIRS, officer: false })

    yield* ctx.agent.transform((draft) => {
      draft.update(AgentV2.BUILD_ID, (item) => {
        item.description = "The default agent. Executes tools based on configured permissions."
        item.system ??= BUILD_SYSTEM
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [{ action: "plan_enter", resource: "*", effect: "allow" }]),
        )
      })

      draft.update(AgentV2.ID.make("plan"), (item) => {
        item.description = "Plan mode. Disallows all edit tools."
        item.mode = "primary"
        // 1I: mutation is three actions now (edit / write-overwrite / create) — plan denies all
        // three, with the plan-file paths allowed for each so the agent can still write plans.
        const planFileAllows = (action: string): PermissionV2.Rule[] => [
          { action, resource: "*", effect: "deny" },
          { action, resource: path.join(".novaclaw", "plans", "*.md"), effect: "allow" },
          {
            action,
            resource: path.relative(worktree, path.join(Global.Path.data, "plans", "*.md")),
            effect: "allow",
          },
        ]
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "plan_exit", resource: "*", effect: "allow" },
            {
              action: "external_directory_read",
              resource: path.join(Global.Path.data, "plans", "*"),
              effect: "allow",
            },
            {
              action: "external_directory_write",
              resource: path.join(Global.Path.data, "plans", "*"),
              effect: "allow",
            },
            ...planFileAllows("edit"),
            ...planFileAllows("write"),
            ...planFileAllows("create"),
          ]),
        )
      })

      // NOVA — the CEO of this instance's organization (AGENTS.md, the structural metaphor). Seeded in
      // CODE, not in the store, so a corrupted or emptied store still boots with a governing agent:
      // "the charter is not editable from inside" is only true if the charter cannot be deleted.
      draft.update(AgentV2.NOVA_ID, (item) => {
        item.name = "Nova"
        item.title = "Chief Executive"
        item.description =
          "Nova, the CEO. Talk to Nova about what you want done; Nova routes it to the colleague who owns that work, or hires one when nobody does."
        item.avatar ??= "⭐"
        item.system ??= NOVA_SYSTEM
        item.memory ??= "own"
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "plan_enter", resource: "*", effect: "allow" },
            // 🔴 The CEO's own job, granted in the charter rather than asked for each time.
            //
            // `colleague` is not in `AMBIENT_SAFE_BASELINE` and must not be: for an ordinary officer,
            // addressing a peer spends someone else's model time and staffing the org creates
            // capability. But routing and hiring are the whole of what Nova IS — a governing agent
            // that must ask permission to do its only job is a CEO in name. The user is in the
            // conversation when it happens, every hire appears immediately on the roster with a name
            // and a brief they can read, and every retire is one click from a re-hire.
            //
            // ⚠️ It grants Nova nothing an officer could not be granted, and nothing beyond this
            // action: no bash, no writes, no wider reach. The org chart limits who may staff
            // (`tool/colleague.ts` → `mayStaff`); this only settles whether the one who may has to
            // ask first.
            { action: "colleague", resource: "*", effect: "allow" },
            // …and the other half of the same sentence: *"executive agents who can communicate with
            // each other AND spawn the nameless sub-agents"*. Nova takes the non-officer floor (it is
            // seeded in code, before any roster exists) and re-allows its own job here, exactly as it
            // does for `colleague` above. `inherit` only — the child runs as Nova, under Nova's
            // ruleset, so this creates a worker and not a privilege. The spawn tool has no named-agent
            // override; changing roles remains an operator/org-chart operation.
            { action: "spawn", resource: "inherit", effect: "allow" },
          ]),
        )
      })

      draft.update(AgentV2.ID.make("general"), (item) => {
        item.description =
          "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."
        item.mode = "subagent"
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "todowrite", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("explore"), (item) => {
        item.description =
          'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'
        item.system = PROMPT_EXPLORE
        item.mode = "subagent"
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              // ONE grant for the search pair, because `glob` and `grep` are ONE action at BOTH
              // seams now: each is registered through `Tool.withPermission(…, "explore")`, so
              // `ToolRegistry.materialize`'s horizon filter resolves the same `explore` the tools'
              // own `permission.assert` spends. This line used to be THREE rules — `explore` for
              // execution plus `grep`/`glob` for the horizon, because `Tool.permission` falls back
              // to the name a tool is REGISTERED under — and dropping either half broke the agent a
              // different way: without `explore` every search was denied while both tools stayed
              // advertised, without `grep`/`glob` the tools vanished from the horizon entirely.
              // ⚠️ It is still load-bearing and must stay AFTER the catch-all deny above. `explore`
              // is in `AMBIENT_SAFE_BASELINE`, i.e. inside `defaults`, which comes BEFORE that deny
              // — and `evaluate` is findLast, so the ambient floor is shadowed here and this rule is
              // the only thing that lets the read-only search agent do its only job. (It was broken
              // before B4c too: the old catch-all ALLOW sat in the same shadowed position.)
              // `test/permission-baseline.test.ts` pins both the execution and the horizon half.
              { action: "explore", resource: "*", effect: "allow" },
              { action: "webfetch", resource: "*", effect: "allow" },
              { action: "websearch", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
            // The external-directory half of the floor, re-applied AFTER the explore grants above so
            // a read-only agent keeps the whitelisted scratch dirs it needs to write its report into.
            floor({ scratchDirs: SCRATCH_DIRS, officer: false }).filter((rule) =>
              rule.action.startsWith("external_directory"),
            ),
          ),
        )
      })

      /**
       * The SERVICE agents. They own the sessions their subsystem starts, so no row is ever
       * ownerless (`AgentV2.MESSENGER_ID` carries the doctrine).
       *
       * ⚠️ They stand on the SAME floor and carry the SAME prompt as `build`, deliberately: these
       * sessions used to run unattributed, which the runner resolved to the default agent. Giving
       * them an owner is a change of BOOKKEEPING, not of what the work may do — a service agent with
       * a narrower permission set would have quietly broken recipe cooking and messaging.
       *
       * ⚠️ `hidden`, so they do not crowd the roster — but named and titled, so a chat they started
       * can be traced to something a person can point at.
       */
      for (const service of [
        { id: AgentV2.MESSENGER_ID, name: "Messenger", title: "Messaging Service" },
        { id: AgentV2.RECIPE_ID, name: "Recipes", title: "Recipe Service" },
      ]) {
        draft.update(service.id, (item) => {
          item.name = service.name
          item.title = service.title
          item.description = `Owns the chats ${service.name} starts, so none of them belongs to nobody.`
          item.system ??= BUILD_SYSTEM
          item.mode = "primary"
          item.hidden = true
          item.permissions.push(
            ...PermissionV2.merge(defaults, [{ action: "plan_enter", resource: "*", effect: "allow" }]),
          )
        })
      }

      draft.update(AgentV2.ID.make("compaction"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = COMPACTION_SYSTEM
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("title"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      draft.update(AgentV2.ID.make("summary"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })
    })
  }),
})
