/**
 * **Which folder a screen sends with a request, said out loud — once.**
 *
 * 🔴 **The finding (RF-19-13 / RF-21-9) and where it was WRONG.** Eighteen call sites across
 * `pages/`, `components/settings-v2/` and `apps/` each resolved this inline, in two orders that
 * disagree whenever the instance is pointed at a project folder — i.e. in the normal case. The
 * sweep read that as one duplication in two camps and prescribed "one order, chosen once".
 *
 * ⚠️ **It is not one thing in two orders. It is TWO things, and the orders are their definitions.**
 * The evidence is in the tree, written by the people who chose each order:
 *
 * - `pages/trash.tsx:38` — *"The trash store is global; `directory` is only for request routing —
 *   the server's home works."* `pages/registry.tsx:83` says the same of the database. These want
 *   ANY directory the instance will accept, and prefer the one that always exists.
 * - `components/settings-v2/project-copy.ts:8` — the Project section resolves its subject as
 *   *"the INSTANCE's directory (`path.directory || path.home`) — correct by design, because Settings
 *   is an instance-wide dialog and not a per-chat one."* `pages/skills.tsx:583` feeds the same value
 *   to `projectState(http, dir)`. These are ABOUT a folder; the routed one is the answer.
 *
 * Collapsing those into one order would have changed what a screen means, not merely where the
 * expression lives — and in the direction that reads a `novaclaw.json` for the wrong folder. So the
 * duplication removed here is the EXPRESSION and the silence around it; the two answers stay, named,
 * so the next edit has to pick one on purpose instead of copying whichever neighbour it read first.
 *
 * ⚠️ Both fall back to `""`, and `""` is falsy on purpose: every caller gates its request on a
 * non-empty directory, and a resource keyed on `""` must stay pending rather than ask the server to
 * route to nowhere.
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
 * `pages/terminal.tsx`, verbatim down to the `.catch(() => undefined)` (RF-19-13). Three copies of a
 * fetch-with-fallback is three chances for one of them to stop falling back, and the symptom is a
 * panel that is permanently empty on a cold client rather than an error anyone would report.
 *
 * ⚠️ **The `.catch` swallows deliberately, and that is inherited, not introduced.** All three copies
 * folded a failed `GET /path` to `""`, which their callers treat as "not ready" — so the panel stays
 * pending instead of asking the server to route to nowhere. It is a real gap that nothing names the
 * fault (the sweep filed it separately as RF-19-4), and moving the code does not close it; keeping
 * one copy is what makes closing it a one-line change instead of a three-file one.
 */
export async function resolveInstanceGlobalDirectory(ctx: DirectoryResolvable): Promise<string> {
  const known = instanceGlobalDirectory(ctx.sync.data.path)
  if (known) return known
  const fetched = await ctx.sdk.client.path
    .get()
    .then((response) => response.data)
    .catch(() => undefined)
  return instanceGlobalDirectory(fetched)
}
