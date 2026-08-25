/**
 * THE LIFECYCLE LENSES — the four questions a person asks of a cabinet of claims.
 *
 * 🔴 This replaces a two-state `Current / Incl. forgotten` toggle whose field nothing read. The
 * toggle was not merely incomplete, it was a **control that could not work**: `MemoryFilter.status`
 * was never consulted by `matches()` and `includeInvalid` was never passed by any caller, so
 * pressing it changed a label and nothing else. A control that cannot work is worse than none —
 * it teaches the user a false model of what the app can do, which is the exact opposite of
 * principle 8.
 *
 * ⚠️ **A lens is a STATUS SET, not a client-side guess.** `/memory/list` filters by `statuses`
 * server-side, so the list asks for what it will show rather than fetching everything and hiding
 * the rest. The Map still receives every status (`/memory/graph` has no such parameter, and that is
 * right — retiring is a thing the map should SHOW happening, not a reason to delete a node), so the
 * same lens dims there instead of filtering. That asymmetry is the one this page already lives by:
 * the list answers "what do you remember", the map answers "how does it connect".
 */

/** The statuses core's `claim.ts` defines. Named here so a lens cannot invent a fifth. */
export const CLAIM_STATUSES = ["active", "needs_review", "superseded", "archived"] as const

export type LensID = "current" | "needs-review" | "never-used" | "history"

export interface Lens {
  readonly id: LensID
  /** What the tab says. */
  readonly label: string
  /**
   * The status set to ask the server for. `undefined` = every status, history included — which is
   * what `/memory/list` does with an absent `statuses`, so History is the parameter's own default
   * rather than a set this file has to keep in step with core's enum.
   */
  readonly statuses: readonly string[] | undefined
  /**
   * Ask for memories that have been FORGOTTEN as well.
   *
   * 🔴 **Forgetting and retiring are two different mechanisms, and `status` only knows about one.**
   * Measured 2026-08-25 against a live instance: `POST /memory/invalidate` closes a row's validity
   * bitemporally and leaves `status` reading `active`, so a status set can never reach it — the row
   * simply stops being returned. Only `includeInvalid` brings it back. A History lens that passed
   * `statuses` alone would therefore promise "everything" and quietly omit exactly the memories a
   * person went looking for after pressing Forget.
   *
   * ⚠️ And the row it brings back still says `active`, so the LIST has to work out which rows those
   * were — see `forgottenIDs` below. That is the honest half: a row shown in History with no badge
   * reads as current, which is the confident lie this whole slice keeps deleting.
   */
  readonly includeInvalid: boolean
  /** ONE line saying what is in force, per principle 12(d). The rest belongs in the panel. */
  readonly hint: string
  /**
   * Is there a data source behind this lens on THIS instance?
   *
   * 🔴 `never-used` is `false` until the P3 access ledger lands. Rendering it as an empty list would
   * be the empty-cabinet lie in its newest costume — "nothing here is unused" is a confident claim
   * about a measurement nobody has taken. So it renders an honest "not measured yet" instead.
   */
  readonly measured: boolean
}

export const LENSES: readonly Lens[] = [
  {
    id: "current",
    label: "Current",
    // `needs_review` is IN current on purpose, and against the instinct to hide it: core's recall
    // includes it too (down-ranked), because dropping a flagged-but-uncontradicted claim turns a
    // renamed file into silent amnesia. A lens that hid what recall still uses would misreport
    // what Nova is working from.
    statuses: ["active", "needs_review"],
    includeInvalid: false,
    hint: "What NovaClaw treats as true right now.",
    measured: true,
  },
  {
    id: "needs-review",
    label: "Needs review",
    statuses: ["needs_review"],
    includeInvalid: false,
    hint: "Claims whose evidence moved — still in use, still down-ranked, worth a look.",
    measured: true,
  },
  {
    id: "never-used",
    label: "Never used",
    statuses: ["active", "needs_review"],
    includeInvalid: false,
    hint: "Not measured yet on this instance.",
    measured: false,
  },
  {
    id: "history",
    label: "History",
    statuses: undefined,
    includeInvalid: true,
    hint: "Everything — corrected, archived and forgotten included.",
    measured: true,
  },
]

const DEFAULT_LENS = LENSES[0]!

export const lensByID = (id: string | undefined): Lens =>
  LENSES.find((lens) => lens.id === id) ?? DEFAULT_LENS

export const defaultLens = (): LensID => DEFAULT_LENS.id

/** Does one row's status belong in this lens? The client half of the same question. */
export function lensAdmits(lens: Lens, status: string | undefined): boolean {
  if (lens.statuses === undefined) return true
  // ⚠️ A row with no status at all is treated as `active`. An older instance predates the column,
  // and dropping its rows would make the whole cabinet vanish behind a lens — a filter is allowed
  // to narrow, never to erase what it cannot classify.
  return lens.statuses.includes(status && status.length > 0 ? status : "active")
}

/**
 * HOW A NON-CURRENT STATUS READS — the same words wherever the status is shown.
 *
 * ⚠️ `active` gets NO badge. A tag on every row saying "active" trains the eye to skip exactly the
 * place the one meaningful word will appear, and the point of the badge is that it is rare.
 *
 * ⚠️ The words are the user's, not the schema's. `superseded` is a database state; **"Corrected"**
 * is what happened, and the difference decides whether a person can act on the row.
 */
export interface StatusBadge {
  readonly label: string
  readonly title: string
  readonly tint: string
  readonly ink: string
}

export function statusBadge(status: string | undefined): StatusBadge | undefined {
  switch (status) {
    case "needs_review":
      return {
        label: "Needs review",
        title: "The source this came from moved. Still used, ranked lower — the citation is stale, not the fact.",
        tint: "#e0a33e2b",
        ink: "#e0a33e",
      }
    case "superseded":
      return {
        label: "Corrected",
        title: "A later claim replaced this one. It is kept as history rather than deleted.",
        tint: "#8b5cf62b",
        ink: "#a78bfa",
      }
    case "archived":
      return {
        label: "Archived",
        title: "Set aside by a decision. It is not recalled, and it can be restored.",
        tint: "#94a3b82b",
        ink: "#cbd5e1",
      }
    default:
      return undefined
  }
}

/**
 * A FORGOTTEN memory, in History. Not a `status` — see `Lens.includeInvalid` for why there is no
 * status to read — so it is carried as a set of ids beside the rows.
 */
export const FORGOTTEN_BADGE: StatusBadge = {
  label: "Forgotten",
  title: "Removed from what NovaClaw uses. It is kept here so you can see it happened.",
  tint: "#94a3b82b",
  ink: "#cbd5e1",
}

/**
 * WHICH ROWS IN A HISTORY READ WERE THE FORGOTTEN ONES.
 *
 * 🔴 Derived by DIFFERENCE because the wire carries no validity field: the same query answered with
 * and without `includeInvalid` differs by exactly the invalidated rows. Two reads rather than one,
 * and only on a lens somebody deliberately opened.
 *
 * ⚠️ The alternative was to show them unmarked, and that is not a smaller version of this — a
 * forgotten memory listed beside current ones with nothing distinguishing it says NovaClaw still
 * knows something it does not. The whole reason History exists is to show that forgetting happened.
 */
export function forgottenIDs(
  all: readonly { readonly id: string }[],
  stillValid: readonly { readonly id: string }[],
): ReadonlySet<string> {
  const valid = new Set(stillValid.map((row) => row.id))
  const gone = new Set<string>()
  for (const row of all) if (!valid.has(row.id)) gone.add(row.id)
  return gone
}

/**
 * 🔴 **THE ONE FUNCTION TO SWAP when the P3 access ledger lands.**
 *
 * Today no surface can say when a claim was last recalled: `memory.recalled` rides the bus live and
 * is never durable, and there is no `/memory/access` to ask. So this returns the rows UNFILTERED
 * together with the reason it could not answer, and the list renders the reason instead of the
 * rows. When the ledger exists, this becomes `rows.filter(r => ledger.lastUsed(r.id) === undefined)`
 * with `unmeasured: undefined`, and nothing else on the page changes.
 */
export function applyLens<T extends { readonly status?: string }>(
  lens: Lens,
  rows: readonly T[],
): { readonly rows: readonly T[]; readonly unmeasured: string | undefined } {
  const admitted = rows.filter((row) => lensAdmits(lens, row.status))
  if (lens.measured) return { rows: admitted, unmeasured: undefined }
  return {
    rows: admitted,
    unmeasured:
      "NovaClaw is not yet recording which memories get recalled, so it cannot say which have never been used.",
  }
}
