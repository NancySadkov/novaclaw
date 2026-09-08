/**
 * WHO IS ASKING — the scope set every id-based memory operation must carry.
 *
 * 🔴 The defect this exists for, measured against the shipping engine on 2026-08-25 (filed as
 * NC-SEC-016, revalidated here rather than trusted):
 *
 *     search({ scopes: ["global", "session:bob"] })      -> []              ✓ enforced
 *     neighbors("G")                                     -> S and O, WITH THEIR TEXT
 *     path("G", "S")                                     -> {hops: 1}
 *     invalidate("S")                                    -> succeeded
 *     purge("O")                                         -> succeeded, row gone
 *
 * `G` is global; `S` is one chat's private memory; `O` is one colleague's cabinet. A global node
 * bridging to a private one discloses that node's id and text to any other chat, which can then
 * destroy it. No id guessing, no elevated permission, no plugin — the bridge is an ordinary relation
 * the model-facing `kb` tool creates.
 *
 * 🔴 **The mechanism that caused it: the scope set was OPTIONAL.** `neighbors` applied a scope
 * predicate "only when the caller supplied `opts.scopes`", so forgetting it was not an error — it was
 * a wider query. Every enforcement that depends on each call site remembering will eventually meet a
 * call site that did not. So the parameter is REQUIRED and its type is this, not `string[]`: passing
 * the whole cabinet has to be something a reader can see at the call site and name out loud.
 *
 * The vision states the rule twice — *the filing cabinet: a D&D companion's recall never reaches the
 * trading desk*, and *authority narrows downward and never widens*.
 */
export interface MemoryAccess {
  /** The scopes this caller may read and mutate. `undefined` means every scope — see `everything`. */
  readonly scopes: readonly string[] | undefined
  /** Why this caller has the reach it does, for diagnostics and for the reader of the call site. */
  readonly as: "owner" | "session" | "system"
}

/**
 * THE HUMAN, at their own instance — every scope, deliberately.
 *
 * The Memory app is the surface where a person asks "what do you remember about me" and answers "and
 * stop remembering it". Confining that to one chat would be a different product. This is a privilege,
 * so it is spelled at the call site rather than reached by omitting an argument.
 *
 * ⚠️ NEVER reachable from a model. The `kb` tool builds its access from the session it is running in;
 * an agent that could construct this would have exactly the authority NC-SEC-016 describes.
 */
export const owner = (): MemoryAccess => ({ scopes: undefined, as: "owner" })

/**
 * INTERNAL MAINTENANCE — consolidation, retirement, legacy discards.
 *
 * Distinct from `owner` only in what it says: these run on the instance's own behalf with no user
 * asking, and a reader should be able to tell the two apart in a stack trace or a log.
 */
export const system = (): MemoryAccess => ({ scopes: undefined, as: "system" })

/** A model turn: exactly the scopes that session may see. */
export const of = (scopes: readonly string[]): MemoryAccess => ({ scopes: [...scopes], as: "session" })

/**
 * The NARROWEST of two scopes, for an edge joining them.
 *
 * 🔴 An ordinary relation must never PROMOTE visibility. The `kb` tool created every edge as `global`,
 * which is how a private node became reachable from a shared one in the first place. Narrowest wins:
 * a session memory joined to a global one produces a session-scoped edge, so traversing to it needs
 * that session's access. Consolidation stays the ONE deliberate promotion, and it says so.
 *
 * The ordering is by reach — `global` is the widest, everything else is narrower than it. Between two
 * different narrow scopes there is no containment at all, so the FIRST is chosen and the caller is
 * expected to have refused the relation before reaching here.
 */
export const narrowest = (a: string, b: string): string => {
  if (a === b) return a
  if (a === "global") return b
  if (b === "global") return a
  return a
}

/** Do two scopes belong to the same private space, or is one of them shared? */
export const compatible = (a: string, b: string): boolean => a === b || a === "global" || b === "global"

// Canonical memory scopes, shared by tools and colleague lifecycle operations.
export const agentScope = (agent: string | undefined): string | undefined =>
  agent === undefined || agent === "" ? undefined : `agent:${agent}`

/** Which scopes a `search` reads. `all` is everything this agent may see — never another agent's
 *  cabinet, which is not reachable through any value of this parameter. */
export const scopesForSearch = (
  session: string,
  agent: string | undefined,
  scope: "session" | "agent" | "global" | "all" | undefined,
): string[] => {
  const own = agentScope(agent)
  if (scope === "session") return [session]
  if (scope === "global") return ["global"]
  // A request for `agent` on a session that has none degrades to this chat rather than to `global`:
  // widening a narrowing request is the one direction that can leak.
  if (scope === "agent") return own === undefined ? [session] : [own]
  return own === undefined ? [session, "global"] : [session, own, "global"]
}

/** Where a `remember`/`ingest` writes. The default is the OFFICER's cabinet — an officer's durable
 *  fact belongs to the officer, not to whichever chat was open and not to the household pile every
 *  other agent reads. With no agent, `global` remains the durable default, as before. */
export const scopeForWrite = (
  session: string,
  agent: string | undefined,
  scope: "session" | "agent" | "global" | undefined,
): string => {
  if (scope === "session") return session
  if (scope === "global") return "global"
  return agentScope(agent) ?? "global"
}
