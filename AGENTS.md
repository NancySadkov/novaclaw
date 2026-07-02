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
2. **A user-friendly UI** — the desktop app, web app, and TUI that make driving agents
   pleasant for non-experts.

Everything else is deliberately **not** kernel: LSP servers, code indexers, editor
integrations, and similar developer services are things an **agent sets up for itself** when
a task needs them (it has a shell; it can install and run tooling), or that **third-party
developers ship as apps** on top of the OS. NovaClaw provides the robust framework (tools,
spawn, MCP, the app registry) to host such capabilities — it does not bundle them. When in
doubt about a feature: if it isn't kernel or UI, it's an app.

NovaClaw runs entirely against local models (e.g. vLLM on a DGX Spark) — no paid APIs, no
telemetry, no data egress. Cloud model endpoints are optional *devices* a user may add, never
dependencies.

## Repository layout

```
├── packages/
│   ├── novaclaw/              # main package: the `novaclaw` CLI + V1 server/runtime (live prompt path)
│   ├── core/                  # V2 kernel: session runtime/runner, tools, DB (Drizzle/SQLite), Effect layers
│   ├── llm/                   # schema-first LLM core: typed request/response/events, wire protocols
│   ├── schema/                # shared Effect Schema semantic values (leaf)
│   ├── protocol/              # V2 API route/schema definitions (HTTP paths, payloads, streams)
│   ├── server/                # V2 Effect HttpApi server assembly (hosts protocol groups over core)
│   ├── client/                # GENERATED V2 clients (from protocol/server via httpapi-codegen)
│   ├── sdk/                   # GENERATED legacy JS SDK (js/src/gen — never hand-edit)
│   ├── sdk-next/              # transitional Effect-native in-process host (composes client+core+server)
│   ├── plugin/                # public plugin API surface
│   ├── app/                   # SolidJS web app; also the desktop renderer (apps/ = home-app registry)
│   ├── desktop/               # Electron desktop app (electron-vite + electron-builder)
│   ├── tui/                   # terminal UI (@opentui/solid)
│   ├── session-ui/            # session message rendering shared by app/TUI
│   ├── ui/                    # shared Solid component library, themes, icons, i18n styles
│   ├── cli/                   # standalone CLI binary packaging (bin: lildax)
│   ├── effect-drizzle-sqlite/ # Effect wrapper for drizzle-orm over SQLite
│   ├── effect-sqlite-node/    # Effect SQLite client for the Node runtime (Electron)
│   ├── http-recorder/         # record/replay HTTP/WS cassettes for provider tests
│   ├── httpapi-codegen/       # build-time generator producing packages/client
│   └── script/                # shared build/release script helpers
├── script/                    # repo dev scripts (generate, format, upgrade-opentui, sign-windows)
├── specs/                     # internal design docs (V2 architecture, session runtime, storage)
├── patches/                   # bun patchedDependencies
├── perf/                      # test-suite profiling notes
├── licenses/ + NOTICE         # retained upstream MIT attribution — keep
└── novaclaw.jsonc convention  # user config file name; project dir convention is .novaclaw/
```

Dependency direction: keep runtime dependencies directed from Schema to Core and Protocol,
then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol
but never Core or Server; `sdk-next` composes Client, Core, and Server.

## Build & run

Requires **Bun 1.3.14** (`npm install -g bun@1.3.14`) and Node 24+ (Electron tooling).

```sh
bun install                    # one-time setup (repo root)

# CLI / server (the live product entrypoint)
bun run dev -- --help          # runs packages/novaclaw/src/index.ts
bun run --conditions=browser packages/novaclaw/src/index.ts serve --port 4096

# Desktop app (packages/desktop)
bun run dev                    # electron-vite dev: Vite HMR renderer + server sidecar
bun run prebuild && bun run build && bun run package:win
                               # packaged build -> dist/win-unpacked/NovaClaw Dev.exe

# Web app (packages/app)
bun run dev                    # Vite on :3000; connects to a server on :4096

# TUI
bun run dev                    # from packages/tui
```

- **Typecheck:** `bun turbo typecheck` from the repo root, or `bun typecheck` from a package
  dir. Never run `tsc`/`tsgo` directly against a package without its config.
- **Tests:** run from package dirs (e.g. `cd packages/novaclaw && bun test test/config`).
  Tests cannot run from the repo root (guard: `do-not-run-tests-from-root`).
- **Legacy JS SDK regen:** `./packages/sdk/js/script/build.ts` (or `bun run script/generate.ts`
  from the root, which also refreshes `packages/sdk/openapi.json`).
- **V2 client regen:** after changing the public Protocol or Server `HttpApi`, run
  `bun run generate` from `packages/client`. Do not edit `src/generated` or
  `src/generated-effect` directly.
- The desktop build only produces `out/`; you also need `package:win` to get the packaged
  exe. Close running instances first or packaging can't overwrite the binary.

## Git

- The default branch in this repo is `dev`. Local `main` may not exist; use `dev` or
  `origin/dev` for diffs.
- Branch names: at most three hyphen-separated words, no slashes or type prefixes
  (`session-recovery`, `fix-scroll-state`, `regenerate-sdk`).
- Commits/PR titles: conventional style `type(scope): summary` with types `feat`, `fix`,
  `docs`, `chore`, `refactor`, `test`; scopes are optional package/area names such as `core`,
  `novaclaw`, `tui`, `app`, `desktop`, `sdk`, `plugin`.

## Style Guide

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
