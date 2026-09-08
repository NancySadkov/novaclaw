/**
 * **Which folder a screen sends with a request, said out loud — once.**
 *
 * 🔴 **The finding this file closes, and where that finding was WRONG.** Eighteen call sites across
 * `pages/`, `components/settings-v2/` and `apps/` each resolved this inline, in two orders that
 * disagree whenever the instance is pointed at a project folder — i.e. in the normal case. The
 * sweep read that as one duplication in two camps and prescribed "one order, chosen once".
 *
 * ⚠️ **It is not one thing in two orders. It is TWO things, and the orders are their definitions.**
 * The evidence is in the tree, written by the people who chose each order:
 *
 * - `pages/trash.tsx` — *"The trash store is global; `directory` is only for request routing —
 *   the server's home works."* `pages/registry.tsx` says the same of the database. These want
 *   ANY directory the instance will accept, and prefer the one that always exists.
 * - `components/settings-v2/project-copy.ts` — the Project section resolves its subject as
 *   *"the INSTANCE's directory (`path.directory || path.home`) — correct by design, because Settings
 *   is an instance-wide dialog and not a per-chat one."* `pages/skills.tsx` feeds the same value
 *   to `projectState(http, dir)`. These are ABOUT a folder; the routed one is the answer.
 *
 * Collapsing those into one order would have changed what a screen means, not merely where the
 * expression lives — and in the direction that reads a `novaclaw.json` for the wrong folder. So the
 * duplication removed here is the EXPRESSION and the silence around it; the two answers stay, named,
 * so the next edit has to pick one on purpose instead of copying whichever neighbour it read first.
 *
 * ⚠️ **Both fall back to `""`, and `""` means the instance named no folder** — never that the read
 * failed. Every caller gates its request on a non-empty directory, so a resource keyed on `""` never
 * asks the server to route to nowhere; what a caller must NOT do is leave it there silently, because
 * a gate that never opens is a spinner that never resolves. `answeredNothing` is the reading that
 * separates it from "not asked yet", and `resolveInstanceGlobalDirectory` below rejects rather than
 * producing this value when the request itself failed.
 */

/** The subset of the SDK's `Path` these two decisions read. Both fields are optional because the
 *  store holds `undefined` until `GET /path` has answered. */
export interface RoutablePath {
  readonly home?: string
  readonly directory?: string
}

/**
 * **The folder a screen is ABOUT.** The routed directory when the instance has one, else its home.
 *
 * Use this whenever the folder is the SUBJECT — a project file is read from it, a policy applies to
 * it, a skill is resolved inside it, a draft opens in it. Getting this one wrong shows the user
 * facts about a folder they are not looking at.
 */
export const scopedDirectory = (path: RoutablePath | undefined): string => path?.directory || path?.home || ""

/**
 * **Any folder that will route an INSTANCE-GLOBAL request.** The home when there is one, else the
 * routed directory.
 *
 * Use this when the store being addressed belongs to the install rather than to a folder — trash,
 * the registry, the scheduler, the memory graph, a pty. The value is a routing token and nothing on
 * the screen is about it, so the stable answer (home, which always exists) is preferred to the
 * variable one.
 */
export const instanceGlobalDirectory = (path: RoutablePath | undefined): string => path?.home || path?.directory || ""

/** The shape `global.ensureServerCtx(connection)` returns, narrowed to what the read below needs. */
export interface DirectoryResolvable {
  readonly sync: { readonly data: { readonly path?: RoutablePath } }
  readonly sdk: {
    readonly client: { readonly path: { readonly get: () => Promise<{ readonly data?: RoutablePath }> } }
  }
}

/**
 * **Read the routing directory for an instance-global panel: the sync store first, `GET /path` only
 * if the store has not answered yet.**
 *
 * ⚠️ This was the same nine lines three times over — `pages/trash.tsx`, `pages/registry.tsx` and
 * `pages/terminal.tsx`, verbatim down to the `.catch(() => undefined)`. Three copies of a
 * fetch-with-fallback is three chances for one of them to stop falling back, and the symptom is a
 * panel that is permanently empty on a cold client rather than an error anyone would report.
 *
 * 🔴 **It REJECTS when `GET /path` fails, and that is the whole point of keeping one copy.** All
 * three originals folded the failure into `""`, and `""` is the value their callers read as *"not
 * asked yet"* — so a broken path lookup left every panel keyed on it sitting at a spinner that
 * nothing would ever resolve. That is the same false claim as an empty list wearing a different
 * animation, and it is the second half of ruling 2: *an unavailable subsystem names itself instead
 * of rendering empty.* A rejection is the only value that cannot be mistaken for an answer, so this
 * function raises it and `utils/settled-resource.ts` classifies it — do NOT put a `.catch` back.
 *
 * ⚠️ **A 200 with no usable body still returns `""`**, because that IS an answer: the instance told
 * us it has neither a home nor a routed directory. Callers separate the two with `answeredNothing`,
 * which is `state === "ready" && !value` — a settled, unfailed read that produced nothing usable.
 *
 * ⚠️ **Every caller must therefore hold this in a `createSettledResource`**, never a bare
 * `createResource`: an errored resource re-throws from its own accessor, so reading it unguarded
 * hands the outage to the root `ErrorBoundary` and replaces the application. All three live callers
 * do (`pages/trash.tsx`, `pages/registry.tsx`, `pages/terminal.tsx`), and
 * `utils/settled-resource-ledger.test.ts` is what keeps a fourth from arriving with a bare one.
 */
export async function resolveInstanceGlobalDirectory(ctx: DirectoryResolvable): Promise<string> {
  const known = instanceGlobalDirectory(ctx.sync.data.path)
  if (known) return known
  const fetched = await ctx.sdk.client.path.get().then((response) => response.data)
  return instanceGlobalDirectory(fetched)
}
