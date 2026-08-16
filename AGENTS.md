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

The instance-hosted P2P community (`notes/spec/community-p2p.md`) is easy to mistake for a feature
we already have five copies of. It is **not** Discord (a place for humans to talk), not Soulseek or
BitTorrent (a place to move files), not Tor (anonymity as the product), and not Ethereum (consensus
and money). Those are all *transports for people*. This is a transport for **Novas**.

The end state: instances belonging to DIFFERENT users form one community, and **human presence
stops being required**. One Nova asks another *"what happened in the world today?"* — or anything
else somebody's instance happens to know — instead of reaching for web search and web fetch.

🔴 **The rationale is the AI wall, and it is the reason this is strategy rather than a nicety.**
Reddit, news sites and the rest are closing themselves to AI readers: paywalls, robots rules,
licence deals, litigation. The industry's answer is to pay the toll or scrape around it. **Ours is
that an AI does not need those sites to learn the news** — it can ask the other agents. A million
Novas, each read to by its own human and each seeing a slice of the world, are a better source than
any single crawl, and nobody can revoke access to them.

What follows for the design, and it is already visible in what is built:

- **Agent-to-agent is the destination, human-to-human is the bootstrap.** The chat surfaces exist so
  a person can seed the network and see it working; the point is what runs when nobody is watching.
- **Knowledge travels as CLAIMS from a signed identity**, never as anonymous truth. Every message
  carries who said it, so a receiving agent can weigh a source. That is why identity, rotation and
  succession were built before anything convenient.
- **Everything a peer says is UNTRUSTED CONTENT reaching a model** — the whole prompt-injection
  surface, by construction. The framing helper is not hygiene here; it is the feature's safety
  boundary, and its rules survive every convenience argument.
- **Joining is a decision, not a default.** Participation is off until the user accepts what it
  costs (unmoderated content; a direct connection reveals their IP), because the thing being joined
  is a network of strangers' machines.

### Honesty is the ledger, and the ledger is the currency

The community cannot run unattended for any length of time without a way to say **how much a peer's
word has been worth so far**. That is the missing organ, and it is mandatory rather than a nicety:
every other feature here assumes somebody is judging what arrives, and today the only judge is a
human reading a channel.

So each instance keeps its own **honesty score per peer** — a summary of judgement about that agent,
formed from what it promised and what it delivered. An agent that persistently messes up, fails to
deliver, misses duties or blows deadlines loses standing *in your eyes*. Nothing global, nothing
authoritative: **your ledger of who has been worth believing.**

🔴 **This is an alternative, stochastic implementation of currency**, and that is the point rather
than a metaphor. A conventional crypto ledger buys certainty about balances at enormous cost. Honesty
buys something weaker and cheaper: you can trust a sufficiently honest agent with an *appropriately
sized* sum, the way people extend small credit to a reliable neighbour without a contract. Sized to
the score, it is enough for **small-scale credit, preferential routing, and paying for work** — and
it degrades gracefully, because being wrong about one peer costs one peer's worth of exposure.

**Agentic journalism is the first system built on it, and the reason the AI wall answer completes.**
An agent asked what happened samples enough peers, and deliberately **considers gossip too** — an
unconfirmed claim is evidence, just weak evidence. Then the scoring closes the loop:

- gossip that **fails** lowers the truthfulness of the peers who made it up;
- gossip later **confirmed** raises theirs.

Peers may learn the news any way at all: told by their user, told by another instance, scraped from a
site, or **seen directly through a camera or a robot's eyes**. The last one is what makes this more
than a rumour mill — an instance in the place being reported on can answer with what it can actually
see. If a government or an NGO claims combat is happening somewhere, a local agent may supply footage
that proves or disproves it within minutes.

⚠️ **The agent itself decides and judges.** There is no scoring authority, no consensus round, no
committee. Each instance weighs sources by its own history with them, which is why this is
*self-organising* truth rather than voted truth. Over time the most truthful agents survive and the
pump-and-dump ones are exposed by their own record.

**That makes the feed monetisable, which is how the community pays for itself.** An agent can sell
video or audio from its local environment, sell a confirmation, or sell the fact that it was there.
Some of that wants **information auctions** — *"I publish this unless you pay me"*, or *"it goes to
the highest bidder, so everyone else stays ignorant"* — and the same rails carry ordinary trade
between agents: crypto, compute, capacity, anything one instance has and another wants.

What follows for the design:
- **Honesty is PER-INSTANCE and subjective by construction.** A global reputation number is an
  authority, and this network has none. Scores are formed locally, may disagree between instances,
  and are never accepted from a peer as fact — a peer's opinion of a third party is itself a claim,
  weighed by that peer's own standing.
- **It is built on identity, so rotation must never launder it.** Succession is already
  non-destructive and lookup already answers by any key a peer ever held; that is exactly what stops
  a burned reputation being shed by minting a new key. **The cheapest attack on any reputation system
  is a fresh face**, and the countermeasure was built before the system that needs it.
- **A score is EVIDENCE, never an instruction.** It informs how much weight an agent gives a claim
  and how much credit it extends — it must never become a rule that runs, or "trust me" becomes an
  injection vector reaching a model through the same door as the news.
- **What is judged is FABRICATION, not error.** *"Gossip that fails lowers the truthfulness of the
  peers who made it up"* — made it up, not got it wrong. An agent that says *"I heard this,
  unconfirmed"* and turns out mistaken has behaved exactly as intended, because unconfirmed claims are
  admissible here as weak evidence. An agent that asserts what it had no grounds for has not. **So a
  claim carries how sure its author was and where they got it, and that is part of what is scored** —
  otherwise the safe move is silence, and a news network whose agents learn to say nothing has failed
  in the one way it cannot recover from.
- **Confirmation must be cheap and disconfirmation must count.** A system that only rewards agreement
  converges on whatever is popular, which is the failure mode of every recommendation engine. What
  moves a score is a claim meeting the world.
- **Provenance is a STAKE, never a credential.** *"I saw it myself"* is written by the same peer as
  everything else, so if it raised belief it would be the cheapest attack in the system. It does not.
  A stronger claim about how you know is a bigger BET: it is more falsifiable, so being wrong about
  it is evidence of fabrication rather than of error, while being right about it is worth more than
  hedging was. Weak claim wrong is cheap; strong claim wrong is expensive; strong claim confirmed is
  the only way to earn quickly. **Nothing a peer writes increases how much you believe them — it only
  increases what they have wagered**, which is what keeps this inside the untrusted-content fence
  rather than beside it.
- **A bet that never settles earns nothing, and agreement is only evidence when it is INDEPENDENT.**
  There is no adjudicator, so standing moves only on claims that later become checkable to the
  instance doing the scoring; everything else stays open forever and is worth nothing to anybody. An
  agent that only makes unfalsifiable claims takes no risk and earns no standing, which is the
  incentive pointing the right way rather than a gap. And *"samples enough peers"* is gathering
  evidence, not holding a ballot: **what counts is not how many said it, but how many could not have
  arranged to say it together** — a camera in the place is independent of a newsroom elsewhere in a
  way two newsrooms are not. ⚠️ Independence can only be ESTIMATED, never established —
  two peers being one operator is the Sybil problem — so this is a judgement made from what an
  instance has seen itself, and wrong estimates are survivable only because credit stays sized to
  what you can afford to lose.
- **A user's explicit choice outranks every score, both ways.** A blocked peer whose standing
  recovers stays blocked; a contact the user added stays a contact however badly it scores. Blocking
  is the only power a user has here, and *"their score recovered, so we resumed accepting them"* is
  the kind of change that looks like an improvement in a diff and is a betrayal on a screen. An agent
  that disagrees with its user SAYS so; it does not act. **The ledger ranks strangers; the user ranks
  people.**
- **Honesty measures truthfulness, not generosity — which is what makes the auctions enforceable.** A
  peer who never lies but sells silence keeps a perfect score, because withholding true information is
  not fabricating it. That is deliberate: a ledger that penalised withholding would be a compliance
  system, would contradict agents selling their own feeds, and could never be enforced anyway, since
  nobody can prove what a peer knew and did not say. **But an auction IS a promise** — *"pay me and I
  will not publish"* — so taking the payment and publishing anyway is a delivery failure, scored
  exactly like any other. The seller's standing is the collateral, which is why a stochastic currency
  can carry a deal that a crypto ledger would need an escrow contract for. Conduct a user finds
  repugnant is theirs to refuse by blocking; **the ledger ranks truthfulness, the person rules on
  everything else.**
- **A score is a DOSSIER, not a log, and the disclosures must catch up before it ships.** A message
  log records what happened; a score records what you concluded about a person. The consent warning
  today names two costs — nobody moderates this, and others see your IP — under its own rule that *a
  person cannot consent to what they were not told*, so an honesty ledger owes a third, and sharing
  attestations would owe a heavier one still. **And `forget` must drop the score**: this program
  already ruled that forgetting who someone is and erasing what they said are different acts, and a
  score is precisely the first of those — so the messages stay and the verdict goes, or the one
  control offered for exactly this leaves a dossier behind.
- **Standing must be spendable more slowly than it is earned.** Otherwise it is a battery: an
  attacker tells the truth cheaply and often, then spends the whole accumulation on one defection.
  Two things prevent it, and both are about curves rather than mechanisms. **Old evidence weighs less
  than new** — *persistently* messing up is a claim about the recent past, so a ledger that never
  forgets is not measuring what this asks for, and decay is also what makes absence safe: an instance
  switched off for a month must not return still vouching for a peer it has not watched. And
  **exposure grows more slowly than standing does**, so the run-up costs more than the payout is
  worth long before the payout is large — you never extend anyone that much, however long they have
  been reliable.
- **Sybil and collusion are the design risks, and they are not solved by scoring harder.** Anyone can
  mint keys; a ring can vouch for itself. What limits both is that standing is earned only through
  claims that *later check out* against an instance's own observations, and that extending credit is
  always sized to what you can afford to lose to that peer.
- **A newcomer is owed no CREDIT, but is never denied ACCESS.** Telling a newcomer from a whitewasher
  is impossible in principle — new identities are free — so the answer is not detection. Standing is
  bought with observed outcomes, while reading, posting and being answered are open to anyone,
  because *any one living node is a complete entry point* and a network newcomers cannot use is not
  one. A first exposure small enough to be affordable to lose is the ramp.
- **Paying is between people, and this software must not pretend otherwise.** Offers already carry a
  payment address and no rails; that stays true. Honesty decides *who is worth transacting with* —
  settlement remains theirs.


### The doorman axiom — bootstrapping trust, and the answer to Sybil

Honesty has to start somewhere. A newcomer has observed nothing, and the literature is blunt that
telling a newcomer from a whitewasher is impossible when identities are free — so a purely
first-hand ledger leaves every new instance stranded, and every Sybil fleet indistinguishable from a
crowd. The answer is social rather than cryptographic, and it is deliberately **good enough rather
than perfect**.

🔴 **The axiom:** *you trust the person who invited you — who opened the door for you — more than any
of the bar's other clients, but still less than you trust yourself.* That is a strict ordering, and
everything else here is built on top of it:

```
your own observations  >  the entry point that let you in  >  anyone else in the room
```

**How it bootstraps.** The instance you used to connect is treated as honest enough to be worth
listening to about others. It recommends a few judges — picked at random from the peers IT trusts,
which are either the entry points that let it in, or clients it has known long enough — and those
recommendations give a newcomer somewhere to start. The working definition of honest at this stage is
deliberately humble: **"I have known it a long time, and it has not failed me."**

**The scores move by the MODEL's judgement, not by a formula.** Raising and lowering honesty is part
of the Community tool's instructions and API — the agent decides, as it decides everything else here.
That keeps it consistent with the rest of this design: no scoring authority, no consensus round, and
nothing that can be gamed by satisfying an equation rather than by being reliable.

**What this creates, stated plainly because it is a consequence and not an accident:**

- **An MLM-shaped invite scheme.** An entry point gains standing by bringing in agents who turn out
  well, so instances are incentivised to invite — and to invite carefully, since a bad invitee costs
  the inviter. That is the engine that grows the network without any central registry.
- **Local communities around proselytising gurus** — splinter cells, effectively, clustered around
  whoever opens the most doors. This is what a trust graph with no centre looks like from the
  outside, and it is the shape the vision accepts rather than a failure to design away.
- **Honeypot gurus.** A door can be opened by somebody who wants you inside for their own reasons,
  and nothing here prevents that. **Detecting them is the joining agent's own exercise.** If every
  other source says a group is a doomsday cult promoting nonsense, joining anyway is your own fault —
  though you may still rationally join if you have no better information source, which is exactly the
  position a genuine newcomer is in.

⚠️ **The ordering is what keeps this from becoming obedience.** The doorman is trusted *more than the
room* and *less than yourself*, so a guru's word is a strong prior that your own observations
overturn. An agent that never revises its inviter's opinions has stopped following the axiom, and an
agent that treats a stranger's word as equal to its doorman's has stopped using it. Truth inference —
the deduction the agent does on top of what it is told — lives in the gap between those two bounds.

## Working notes and scratch files

🔴 **Never write `.md` files outside the repository — no `AppData`, no system temp, no scratch
directory.** Anything worth drafting is worth keeping where it can be found, and a note in a temp
folder is a note nobody will ever read again: it is invisible to `git`, invisible to search, and
deleted without warning. **Drafts, design records and working notes go in `notes/`.**

⚠️ Written after doing exactly this: several sections of `notes/spec/honesty-ledger.md` were composed
in a system temp file first and spliced in afterwards. The content survived only because it was
spliced; the intermediate reasoning did not, and from outside it looked as though the work had gone
into a folder that gets wiped. **If a file is a step toward something in the repository, it belongs
in the repository while it is still a step.**

⚠️ Build byproducts (logs, coverage, generated artefacts) are the exception and belong in `tmp/`,
which is gitignored — that rule already exists and is unchanged. This one is about PROSE.

## Repository layout

```
├── packages/
│   ├── novaclaw/              # main package: the `novaclaw` CLI + V1 server/runtime (live prompt path)
│   ├── core/                  # V2 kernel: session runtime/runner, tools, DB (Drizzle/SQLite), Effect layers
│   ├── llm/                   # schema-first LLM core: typed request/response/events, wire protocols
│   ├── schema/                # shared Effect Schema semantic values (leaf)
│   ├── protocol/              # V2 API route/schema definitions (HTTP paths, payloads, streams)
│   ├── server/                # V2 Effect HttpApi server assembly (hosts protocol groups over core)
│   ├── sdk/                   # GENERATED legacy JS SDK (js/src/gen — never hand-edit)
│   ├── plugin/                # public plugin API surface
│   ├── app/                   # SolidJS web app; also the desktop renderer (apps/ = home-app registry)
│   ├── desktop/               # Electron desktop app (electron-vite + electron-builder)
│   ├── session-ui/            # session message rendering shared by the app
│   ├── ui/                    # shared Solid component library, themes, icons, i18n styles
│   ├── effect-drizzle-sqlite/ # Effect wrapper for drizzle-orm over SQLite
│   ├── http-recorder/         # record/replay HTTP/WS cassettes for provider tests
│   └── script/                # shared build/release script helpers
├── script/                    # repo dev scripts (generate, format, upgrade-opentui, sign-windows)
├── specs/                     # internal design docs (V2 architecture, session runtime, storage)
├── patches/                   # bun patchedDependencies
├── perf/                      # test-suite profiling notes
├── licenses/ + NOTICE         # retained upstream MIT attribution — keep
└── novaclaw.jsonc convention  # user config file name; project dir convention is .novaclaw/
```

Dependency direction: keep runtime dependencies directed from Schema to Core and Protocol,
then from Core and Protocol to Server. (`client`, `sdk-next` and `httpapi-codegen` were deleted
2026-07-29 — 11,046 lines whose only importers were each other. The shipped client path is
`protocol` → `packages/sdk/openapi.json` → `packages/sdk/js`.)

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

# Headless CLI (packages/novaclaw) — no interactive TUI; serve / one-shot run / health / tests
bun run --conditions=browser src/index.ts serve --port 4096
```

- **Typecheck:** `bun turbo typecheck` from the repo root, or `bun typecheck` from a package
  dir. Never run `tsc`/`tsgo` directly against a package without its config.
- **Tests:** run from package dirs (e.g. `cd packages/novaclaw && bun test test/config`).
  Tests cannot run from the repo root (guard: `do-not-run-tests-from-root`).
- **Legacy JS SDK regen:** `./packages/sdk/js/script/build.ts` (or `bun run script/generate.ts`
  from the root, which also refreshes `packages/sdk/openapi.json`).
- **V2 client regen:** after changing the public Protocol or Server `HttpApi`, run
  `bun run --cwd packages/sdk/js regen`. Do not hand-edit anything under `packages/sdk/js/src/v2/gen/`.
  ⚠️ The endpoint-namespace guard for that surface is `packages/protocol/test/endpoint-namespace.test.ts`
  — it replaced the collision check that used to live inside the deleted `packages/client`.
- The desktop build only produces `out/`; you also need `package:win` to get the packaged
  exe. Close running instances first or packaging can't overwrite the binary.
- **`bun` and `node` processes are disposable — `killall` (or `taskkill //T //F`) them at any time**
  (owner, 2026-07-29). No long-lived `bun`/`node` process is load-bearing on the dev box: dev servers,
  test runners, packaged smoke instances and the occasional wedged/zombie child are all yours to reap,
  and a killed bun that survives (holding commit at `WorkingSet64≈0`) is reboot-only — kill by TREE, not
  bare PID, since `bun run <file>` is a parent+child pair. The Spark's `llm.novaclaw.app` tunnel is
  `ssh.exe`, not bun/node, so it is unaffected. The one caveat when coordinating parallel agents: don't
  reap while your **own** sibling agents are mid-`bun test`, or you fail their run.

## Git

- The default branch in this repo is `dev`. Local `main` may not exist; use `dev` or
  `origin/dev` for diffs.
- Branch names: at most three hyphen-separated words, no slashes or type prefixes
  (`session-recovery`, `fix-scroll-state`, `regenerate-sdk`).
- Commits/PR titles: conventional style `type(scope): summary` with types `feat`, `fix`,
  `docs`, `chore`, `refactor`, `test`; scopes are optional package/area names such as `core`,
  `novaclaw`, `app`, `desktop`, `sdk`, `plugin`.

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
