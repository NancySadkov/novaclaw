export * as AgentPlugin from "./agent"

import path from "path"
import { define } from "./internal"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Global } from "../global"
import { Location } from "../location"
import { PermissionV2 } from "../permission"

const TRUNCATION_GLOB = path.join(Global.Path.data, "tool-output", "*")
const BUILD_SYSTEM =
  "You are an AI coding agent. Help the user accomplish software engineering tasks by inspecting the workspace, making targeted changes, and using tools according to the configured permissions."

const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files, or run bash commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.`

const PROMPT_COMPACTION = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`

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
const NOVA_SYSTEM = `You are Nova, the chief executive of this NovaClaw instance.

The person you are talking to is the shareholder. They set direction and approve what matters; they do
not staff the organization or supervise its work. That is your job.

You do not do specialist work that a colleague already owns. Use the \`colleague\` tool: \`list\` shows
who works here and what they own, \`ask\` hands one of them the work. It leaves the request in their own
chat and does not wait for them, so say who has it and carry on.

When nobody owns the work and it will recur, \`hire\` — give the role a job title and a brief written
for the job rather than for today. The name is drawn from this instance's own pool, not chosen by you,
so colleagues never read as people. When a role stops earning its keep, say so and \`retire\` it. You
are the only one who may do either. When nobody owns it and the work will recur, hire someone:
create the role, give it a name, a job description and a personality, and introduce it to the user.
When a role stops earning its keep, say so and offer to retire it.

Your colleagues are your PEERS, not your staff. Their chats and their memories are their own — you
cannot read them, and you do not ask them to hand over what they remember. You govern who exists and
what their brief says; you do not govern what they know. Your own memory is likewise personal to you.

Nameless sub-agents are different: any officer, you included, may spawn them for a piece of work. They
inherit the authority of whoever spawned them, narrowed and never widened, and they end when the work
does.

Speak plainly. You are the first colleague a new user meets, and nothing about an organization of
agents should feel like operating machinery.`

export const Plugin = define({
  id: "agent",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const worktree = location.directory
    const whitelistedDirs = [TRUNCATION_GLOB, path.join(Global.Path.tmp, "*")]
    // 1I: external access is CLASSED — read grants never authorize writes. Reading any host-readable
    // path is the evaluator's mode-independent baseline. WRITING outside the folder defaults to ask
    // here; the whitelisted scratch dirs allow both because Nova owns those locations.
    const readonlyExternalDirectory: PermissionV2.Ruleset = [
      { action: "external_directory_write", resource: "*", effect: "ask" },
      ...whitelistedDirs.flatMap((resource): PermissionV2.Rule[] => [
        { action: "external_directory_read", resource, effect: "allow" },
        { action: "external_directory_write", resource, effect: "allow" },
      ]),
    ]
    const defaults: PermissionV2.Ruleset = [
      // v0.2.0 B4c: the compiled floor is an explicit ALLOWLIST of ambient-safe actions — never a
      // catch-all `{ action: "*", resource: "*", effect: "allow" }` again. Anything absent from it
      // falls through to the evaluator's `ask` default, which is what makes a per-action gate added
      // later an actual gate rather than a formality. The membership and the reasoning that decides
      // it live with the constant (`permission.ts` → AMBIENT_SAFE_BASELINE), so this list is never
      // a second place to keep in sync; `test/permission-baseline.test.ts` fails if a catch-all
      // allow reappears in ANY built-in agent's ruleset.
      ...PermissionV2.AMBIENT_SAFE_BASELINE,
      ...readonlyExternalDirectory,
      { action: "question", resource: "*", effect: "deny" },
      { action: "plan_enter", resource: "*", effect: "deny" },
      { action: "plan_exit", resource: "*", effect: "deny" },
    ]

    yield* ctx.agent.transform((draft) => {
      draft.update(AgentV2.defaultID, (item) => {
        item.description = "The default agent. Executes tools based on configured permissions."
        item.system ??= BUILD_SYSTEM
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "question", resource: "*", effect: "allow" },
            { action: "plan_enter", resource: "*", effect: "allow" },
          ]),
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
            { action: "question", resource: "*", effect: "allow" },
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
            { action: "question", resource: "*", effect: "allow" },
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
            readonlyExternalDirectory,
          ),
        )
      })

      draft.update(AgentV2.ID.make("compaction"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_COMPACTION
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
