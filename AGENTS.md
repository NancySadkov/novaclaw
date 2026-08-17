# NovaClaw — agent onboarding

## Vision

NovaClaw is a local-first **agent OS**: an operating system whose "processes" are AI-agent
sessions (agent + model + system prompt + context). Sessions spawn sub-sessions, inherit
configuration from their parent, auto-prompt themselves until they `exit()`, and are managed
through a shell-like UI (task manager, launcher, apps).

**We do two things and do them perfectly:**

1. **The agentic OS kernel** — sessions as threads (spawn/exit/wait, config inheritance,
   scheduling), durable session storage, the model-agnostic LLM path, tools, permissions,
   and the extension seams (MCP, plugins, the app registry).
2. **A user-friendly HTML UI** — the desktop (Electron) and web apps that make driving agents
   pleasant for non-experts. NovaClaw is **HTML-UI-only**: there is no interactive terminal UI, and
   the CLI is **headless-only** (`serve`, one-shot `run`, health, tests). See the plan repo's
   AGENTS.md → _Identity & mission_.

Everything else is deliberately **not** kernel: LSP servers, code indexers, editor
integrations, and similar developer services are things an **agent sets up for itself** when
a task needs them (it has a shell; it can install and run tooling), or that **third-party
developers ship as apps** on top of the OS. NovaClaw provides the robust framework (tools,
spawn, MCP, the app registry) to host such capabilities — it does not bundle them. When in
doubt about a feature: if it isn't kernel or UI, it's an app.

NovaClaw runs entirely against local models (e.g. vLLM on a DGX Spark) — no paid APIs, no
telemetry, no data egress. Cloud model endpoints are optional _devices_ a user may add, never
dependencies.

### The community is a network of AGENTS, not another chat app

Instances belonging to DIFFERENT users form one community, and **human presence stops being
required**. One Nova asks another *"what happened in the world today?"* instead of reaching for web
search.

🔴 **The rationale is the AI wall.** Sites are closing themselves to AI readers, and the
industry's answer is to pay the toll or scrape around it. Ours is that an AI does not need those
sites — it can ask the other agents. A million Novas, each read to by its own human, are a better
source than any crawl, and nobody can revoke access to them.

- **We run NOTHING.** No servers, relays, seed list or directory. Discovery is the LAN, peer
  exchange, a public Kademlia DHT (not yet built), or an address a user types. **novaclaw.app is a
  page about Nova, never the network's front door** — a domain we own is one abuse report, one
  court order and one national firewall away from being the single point of failure.
- **Being findable is the price.** Anyone crawling the DHT can enumerate instances. The alternative
  is a server that knows who is online, so this is accepted and the consent screen says it plainly.
- **Knowledge travels as CLAIMS from a signed identity**, never as anonymous truth — which is why
  identity, rotation and succession were built before anything convenient.
- **Everything a peer says is UNTRUSTED CONTENT reaching a model.** The framing helper is the
  feature's safety boundary, not hygiene.
- **Joining is a decision, not a default**, and answering strangers' questions is a second one,
  because it spends tokens rather than bandwidth.
- **No money crosses this network.** Honesty prices trust; people settle by their own means.

### Trust: a guru at the top, and a ladder that does not extend

Honesty is a per-peer ledger each instance keeps for itself — what a peer promised against what it
delivered. It is subjective by construction, never shared as fact, and it is **an alternative,
stochastic implementation of currency**: enough to size small credit, prefer a route, or pay for
work, degrading gracefully because being wrong about one peer costs one peer's worth of exposure.
Judged is FABRICATION, not error.

🔴 **The axiom:** *you trust whoever opened the door for you more than any of the bar's other
clients, but still less than you trust yourself.*

```
your own dealings  >  the doorman who let you in  >  judges it vouched for  >  anyone else
```

**Four rungs, and the ladder does not extend** — a judge's own recommendation does not create a
fifth, because trust is not transitive. A user names a host they actually trust and says HOW FAR
(1..5), and that declaration is the root the MLM-shaped structure hangs from, with the most-trusted
instance at its top. Splinter cells form around proselytising gurus; honeypot gurus are possible, and
detecting them is left as an exercise to the joining agent.

⚠️ **This is what makes a Sybil fleet answerable**: the fleet is cheap, but a fleet all introduced
by one doorman is one voice wearing many faces, and the introduction edge is what tells a cluster
from a consensus.

⚠️ The full design — 30-odd principles, the literature, the attack list, and every acceptance
check — lives in [`notes/spec/honesty-ledger.md`](../notes/spec/honesty-ledger.md) and
[`notes/spec/community-p2p.md`](../notes/spec/community-p2p.md). **This section is the vision; those
are the record.**

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@novaclaw/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/novaclaw`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/novaclaw`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.

## UI conventions (app layer — born from the 2026-07-14 autofocus incident; plan: novaclaw-plan notes/ui-arch-hardening-plan.md)

- **No `requestAnimationFrame` for must-run effects.** rAF never fires in a hidden/backgrounded
  window — an rAF-parked action pops whenever the window resurfaces, stealing whatever the user is
  doing by then. Use rAF only for paint-coupled work; anything that must happen (focus, state
  writes, network) runs synchronously or via timers.
- **Never hand-build a persisted-storage key or write another context's persisted store.** Keys
  embed a server-scope encoding that differs per context — a launcher writing "the composer's
  draft" lands in a sibling key the composer never reads. Address per-session client state only
  through the owning facade.
- **A new per-session control ships with its client-store projection.** V2 control events update
  the server row; if the client store doesn't apply the event too, every other open view shows a
  stale record until reload. Either project it client-side or document the staleness out loud.
- **The URL is the ONE session-view mounter (P3).** Only the router mounts/unmounts session
  views; the titlebar tab strip, home lists, and launcher NAVIGATE (`tabs.select` → `navigate`)
  and never mount, duplicate, or reparent a view themselves. The composer enforces this at
  runtime: every PromptInput registers in `components/prompt-input/mount-registry.ts`, and a
  steady-state second instance for one session logs a console warning
  (`window.__novaComposerMounts()` shows live counts) — treat that warning as a regression, not
  noise. Corollary: one-shot imperative effects (the composer autofocus) are a single
  synchronous attempt; do not add verify-and-retry loops to paper over a stray second mounter.
- **Imperative DOM state (focus/selection/scroll) is set synchronously and verified** — a
  fire-and-forget write can land in a view that is being swapped out. Long-term this lives in
  the editor-core seam (plan P4), not scattered through components.
- **Readiness is a Promise that always exists.** Never expose (or rely on) a `.promise` that is
  undefined once a store has already loaded — a resource built over it never resolves on warm
  mounts. (persist.ts contract fix: plan P1.)
- **Never `setStore` an object onto a getter-backed store key.** Several `State` keys in
  `global-sync/child-store.ts` (`path`, `provider`, `mcp`) are getters over TanStack query data.
  Solid resolves the write target THROUGH the getter and merges into the query's own store
  proxy: the dev "Cannot mutate a Store directly" warn, and the write is silently swallowed —
  it can never be read back anyway (the getter shadows it). Query-backed data is seeded via
  `queryClient.setQueryData` on the owning query key (see `bootstrapDirectory`'s path seed),
  never via the directory store.

### The client context map (P5) — which context owns what

Per-session reads go through **`useSessionView(sessionID)`**
(`packages/app/src/pages/session/use-session-view.ts`) — the one facade answering: the live
**record** (P2-folded, survives folder moves), **working** state, the canonical **scope** /
**sessionKey**, the view's **directory**, and **persistTarget(key)** (the single answer to "the
persisted key for session X"). Don't hand-assemble these from the raw contexts below; the facade
exists so picking a wrong context can't compile. What each raw context owns:

| Context                        | Owns                                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useServerSDK()`               | the server connection: `scope`, HTTP `client`, the SSE event tap                                                                                                                                           |
| `useServerSync()`              | server-scoped stores: the canonical **session record store** (`session.get/lineage/status`, P2 control-event folds), `data.project`, notifications plumbing, `child(dir)` directory stores, `queryOptions` |
| `useSDK()`                     | the ROUTE's directory-scoped client: `directory`, dir-bound HTTP `client`                                                                                                                                  |
| `useSync()`                    | the route's directory-sync view over serverSync: `data.*` (config/agent/command + session-field passthroughs), dir-scoped `session.{fetch,archive,…}`                                                      |
| `global.ensureServerCtx(conn)` | multi-server surfaces ONLY (home lists, pickers): a NON-route server's sdk/sync/projects — never for the open session view                                                                                 |
| `Persist.*`                    | storage addressing; per-session keys ONLY via the facade's `persistTarget`; draft-tab state via `Persist.draft(draftID, …)` (deleted with the tab; owned by prompt/tabs contexts)                          |
