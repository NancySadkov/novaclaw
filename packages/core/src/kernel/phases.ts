/**
 * Phases-as-data kernel (the scheduler's structural half — notes/scheduler.md §3).
 *
 * A PHASE is a named point in the kernel loop; a REACTION is (phase, marker, method);
 * running a phase = sweep the entities holding the marker. Mechanisms adopted from
 * flecs/Bevy (research-verified):
 *   - phase order is DATA: a DependsOn DAG, toposorted at registration time;
 *   - third parties register REACTIONS into kernel phases; a new phase MUST anchor
 *     into the existing DAG (no free-floating plugin phases — the Bevy RFC-45 lesson);
 *   - within a phase, reactions run in REGISTRATION ORDER modulo explicit edges
 *     (flecs's declaration-order determinism — replayable, debuggable);
 *   - run conditions are pure predicates attached to reactions, not phase semantics;
 *   - DEFERRED MUTATION invariant: reactions may read freely and write entity
 *     component fields, but STRUCTURAL changes (marker add/remove) queue and flush
 *     BETWEEN phases — a marker added during phase X is swept by phase X+1 in the
 *     same tick, and every phase sees a consistent snapshot;
 *   - one-shot signals are CONSUMED MARKERS (removed by the consuming reaction's
 *     sweep), never TTL-buffered events that can silently expire.
 *
 * The kernel is entity-agnostic: it owns only a marker index keyed by opaque ids.
 * Session integration provides the ids and reads its own stores inside reactions.
 */
export * as KernelPhases from "./phases"

export type PhaseId = string & { readonly __phase: unique symbol }
export type ReactionId = string & { readonly __reaction: unique symbol }

export interface PhaseCtx {
  readonly phase: PhaseId
  readonly tick: number
  /** Structural mutations: queued, applied between phases (never mid-sweep). */
  readonly defer: {
    readonly addMarker: (id: string, marker: string) => void
    readonly removeMarker: (id: string, marker: string) => void
  }
}

export interface ReactionSpec {
  readonly phase: PhaseId
  /** Sweep = every entity currently holding this marker (snapshot at phase start). */
  readonly marker: string
  /** Pure predicates — ALL must pass for the sweep to visit an entity. */
  readonly when?: ReadonlyArray<(id: string, ctx: PhaseCtx) => boolean>
  /** Within-phase ordering edges (registration order otherwise). */
  readonly order?: { readonly after?: readonly ReactionId[]; readonly before?: readonly ReactionId[] }
  /** Consume the marker after sweeping an entity (one-shot signal semantics). */
  readonly consume?: boolean
  readonly fn: (id: string, ctx: PhaseCtx) => void
}

export class KernelError extends Error {
  override readonly name = "KernelPhases.KernelError"
}

interface Reaction extends ReactionSpec {
  readonly id: ReactionId
  readonly seq: number
}

export class Kernel {
  private readonly phaseDeps = new Map<PhaseId, { after: Set<PhaseId> }>()
  private readonly reactions = new Map<ReactionId, Reaction>()
  private readonly markers = new Map<string, Set<string>>()
  private phaseOrder: PhaseId[] = []
  private reactionSeq = 0
  private ticks = 0

  constructor(bootstrap?: readonly string[]) {
    // The built-in chain (short and stable — fine ordering happens INSIDE phases).
    const names = bootstrap ?? ["ingest", "account", "classify", "age", "pick", "dispatch", "flush"]
    let previous: PhaseId | undefined
    for (const name of names) {
      const id = name as PhaseId
      this.phaseDeps.set(id, { after: previous ? new Set([previous]) : new Set() })
      previous = id
    }
    this.resort()
  }

  get phases(): readonly PhaseId[] {
    return this.phaseOrder
  }

  /** New phases MUST anchor into the existing DAG (after and/or before known phases). */
  definePhase(name: string, deps: { after?: readonly PhaseId[]; before?: readonly PhaseId[] }): PhaseId {
    const id = name as PhaseId
    if (this.phaseDeps.has(id)) throw new KernelError(`phase already defined: ${name}`)
    const after = deps.after ?? []
    const before = deps.before ?? []
    if (after.length === 0 && before.length === 0)
      throw new KernelError(`phase "${name}" must anchor into the existing phase DAG (declare after/before)`)
    for (const dep of [...after, ...before])
      if (!this.phaseDeps.has(dep)) throw new KernelError(`phase "${name}" anchors to unknown phase "${dep}"`)
    this.phaseDeps.set(id, { after: new Set(after) })
    for (const target of before) this.phaseDeps.get(target)!.after.add(id)
    this.resort()
    return id
  }

  registerReaction(name: string, spec: ReactionSpec): ReactionId {
    const id = name as ReactionId
    if (this.reactions.has(id)) throw new KernelError(`reaction already registered: ${name}`)
    if (!this.phaseDeps.has(spec.phase)) throw new KernelError(`reaction "${name}" targets unknown phase "${spec.phase}"`)
    for (const ref of [...(spec.order?.after ?? []), ...(spec.order?.before ?? [])]) {
      const other = this.reactions.get(ref)
      if (!other) throw new KernelError(`reaction "${name}" orders against unknown reaction "${ref}"`)
      if (other.phase !== spec.phase)
        throw new KernelError(`reaction "${name}" orders against "${ref}" in a DIFFERENT phase — order edges are within-phase only`)
    }
    this.reactions.set(id, { ...spec, id, seq: this.reactionSeq++ })
    return id
  }

  addMarker(id: string, marker: string): void {
    let set = this.markers.get(marker)
    if (!set) this.markers.set(marker, (set = new Set()))
    set.add(id)
  }

  removeMarker(id: string, marker: string): void {
    this.markers.get(marker)?.delete(id)
  }

  hasMarker(id: string, marker: string): boolean {
    return this.markers.get(marker)?.has(id) === true
  }

  entitiesWith(marker: string): readonly string[] {
    return [...(this.markers.get(marker) ?? [])]
  }

  /** Reactions of a phase in deterministic order: explicit edges, then registration order. */
  private phaseReactions(phase: PhaseId): Reaction[] {
    const list = [...this.reactions.values()].filter((r) => r.phase === phase).sort((a, b) => a.seq - b.seq)
    // Kahn over the explicit edges with registration-order tiebreak.
    const after = new Map<ReactionId, Set<ReactionId>>(list.map((r) => [r.id, new Set(r.order?.after ?? [])]))
    for (const r of list) for (const target of r.order?.before ?? []) after.get(target)?.add(r.id)
    const done: Reaction[] = []
    const pending = [...list]
    while (pending.length > 0) {
      const index = pending.findIndex((r) => [...after.get(r.id)!].every((dep) => done.some((d) => d.id === dep) || !after.has(dep)))
      if (index < 0) throw new KernelError(`ordering cycle among reactions in phase "${phase}"`)
      done.push(pending.splice(index, 1)[0]!)
    }
    return done
  }

  /** One kernel tick: every phase in topo order; deferred mutations flush between phases. */
  tick(): void {
    const tick = ++this.ticks
    for (const phase of this.phaseOrder) {
      const deferred: Array<{ op: "add" | "remove"; id: string; marker: string }> = []
      const ctx: PhaseCtx = {
        phase,
        tick,
        defer: {
          addMarker: (id, marker) => deferred.push({ op: "add", id, marker }),
          removeMarker: (id, marker) => deferred.push({ op: "remove", id, marker }),
        },
      }
      for (const reaction of this.phaseReactions(phase)) {
        // Snapshot at sweep start: entities marked DURING the sweep wait for the next phase.
        for (const id of this.entitiesWith(reaction.marker)) {
          if (reaction.when && !reaction.when.every((cond) => cond(id, ctx))) continue
          reaction.fn(id, ctx)
          if (reaction.consume) deferred.push({ op: "remove", id, marker: reaction.marker })
        }
      }
      for (const change of deferred)
        change.op === "add" ? this.addMarker(change.id, change.marker) : this.removeMarker(change.id, change.marker)
    }
  }

  private resort(): void {
    const remaining = new Map([...this.phaseDeps].map(([id, deps]) => [id, new Set(deps.after)]))
    const order: PhaseId[] = []
    while (remaining.size > 0) {
      const ready = [...remaining].filter(([, deps]) => [...deps].every((dep) => order.includes(dep) || !this.phaseDeps.has(dep)))
      if (ready.length === 0) throw new KernelError("phase DependsOn cycle")
      // Deterministic: among ready phases, keep insertion order.
      const [id] = ready[0]!
      order.push(id)
      remaining.delete(id)
    }
    this.phaseOrder = order
  }
}
