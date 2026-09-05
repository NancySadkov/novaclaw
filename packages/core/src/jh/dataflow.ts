export * as JhDataflow from "./dataflow"

// jh — the typed-dataflow machinery (jh.md §5 laws 5 & 7, §4 complexity trigger). `validate` is the
// pre-execution law-7 check over ONE decomposition (dangling consumes / duplicate produces / unused
// produces). `closure` is the law-5 transitive consumes closure the Context Manager builds a step's
// prompt from; `cardinality`/`density` are the structural complexity metrics the harness force-splits
// on (D8). Pure over an already-built JhTree.

import type { JhStep } from "./step"
import type { JhTree } from "./tree"

export interface Issue {
  readonly severity: "error"
  readonly code: "dangling_consumes" | "duplicate_produce"
  readonly step: number // index into the children array
  readonly artifact: string
}

/**
 * Law 7 over ONE decomposition. `available` = artifact ids provided by ancestors or already-committed
 * work. A child's `consumes` must be in `available` OR produced by an EARLIER sibling (order matters —
 * a sibling cannot consume a later sibling's output). `duplicate_produce`: two siblings, or a sibling
 * and `available`, produce the same id → error. A compound child's produces are its own declared
 * produces (its own attach re-validates internally).
 *
 * 🔴 **WHO READS WHAT, because the two codes have different consumers and only one of them blocks.**
 *  · `dangling_consumes` — the ENGINE. `engine.ts:1251` filters to exactly this code, so it is the
 *    only issue that can block a decomposition.
 *  · `duplicate_produce` — the RIG, not the engine. `tests/jh-expander-smoke.ts:103,110` (outer repo)
 *    filters on `severity === "error"`, which takes both codes, and reports the count as
 *    `dataflowErrors`. The engine deliberately tolerates it (the artifact store is latest-wins) —
 *    `engine.test.ts:709` pins that tolerance.
 *
 * ⚠️ So do not "simplify" this by dropping `duplicate_produce`: it is invisible to the engine and to
 * a `packages/`-only grep, and removing it would silently change a measured number the rig has been
 * reporting. A third code, `unused_produce` (a `warning`), was removed on 2026-09-01 () —
 * that one genuinely had no reader: the engine filters it out, the rig's `severity` filter excludes
 * warnings, and it cost an O(children² × refs) second pass with a fresh `slice` per element on every
 * decomposition.
 */
export function validate(
  children: ReadonlyArray<JhStep.StepDraft>,
  available: ReadonlySet<string>,
): ReadonlyArray<Issue> {
  const issues: Issue[] = []
  const producedByEarlier = new Map<string, number>() // artifact id → first earlier sibling index

  for (let i = 0; i < children.length; i++) {
    // Consumes are checked BEFORE this sibling's own produces register, so a self-loop (consume+produce
    // the same id with no earlier producer) is caught as dangling.
    for (const c of children[i]!.consumes ?? []) {
      if (!available.has(c.id) && !producedByEarlier.has(c.id)) {
        issues.push({ severity: "error", code: "dangling_consumes", step: i, artifact: c.id })
      }
    }
    for (const p of children[i]!.produces ?? []) {
      if (available.has(p.id) || producedByEarlier.has(p.id)) {
        issues.push({ severity: "error", code: "duplicate_produce", step: i, artifact: p.id })
      }
      if (!producedByEarlier.has(p.id)) producedByEarlier.set(p.id, i)
    }
  }

  return issues
}

/** artifactID → producing StepID, over the whole tree (committed or not). Later declarations win. */
export function producerIndex(tree: JhTree.Tree): ReadonlyMap<string, JhStep.StepID> {
  const map = new Map<string, JhStep.StepID>()
  for (const node of tree.nodes.values()) {
    for (const p of node.draft.produces ?? []) map.set(p.id, node.id)
  }
  return map
}

/**
 * Law 5: the transitive closure of a step's `consumes` over the tree — follow each consumed artifact
 * to its producer step, add THAT step's consumes, repeat to fixpoint. Ids without a producer in the
 * tree (ancestor / task-provided) terminate the walk. Deduped, cycle-safe. Does NOT include the step's
 * OWN produces.
 */
export function closure(tree: JhTree.Tree, id: JhStep.StepID): ReadonlySet<string> {
  const node = tree.nodes.get(id)
  if (!node) return new Set()
  const producers = producerIndex(tree)
  const result = new Set<string>()
  const worklist = (node.draft.consumes ?? []).map((r) => r.id)
  while (worklist.length > 0) {
    const aid = worklist.pop()!
    if (result.has(aid)) continue // dedup + cycle guard
    result.add(aid)
    const producerID = producers.get(aid)
    if (!producerID) continue // ancestor/task-provided → terminate this branch
    const producerNode = tree.nodes.get(producerID)
    if (!producerNode) continue
    for (const c of producerNode.draft.consumes ?? []) worklist.push(c.id)
  }
  // Exclude the step's own produces (§5 — its closure is what it READS).
  for (const p of node.draft.produces ?? []) result.delete(p.id)
  return result
}

export function cardinality(tree: JhTree.Tree, id: JhStep.StepID): number {
  return closure(tree, id).size
}

/** Dependency density of one decomposition: count of (artifact, producer-sibling i, consumer-sibling
 *  j, i<j) triples. Ancestor-provided consumption does not count. */
export function density(children: ReadonlyArray<JhStep.StepDraft>): number {
  let count = 0
  for (let j = 0; j < children.length; j++) {
    for (const c of children[j]!.consumes ?? []) {
      for (let i = 0; i < j; i++) {
        if ((children[i]!.produces ?? []).some((p) => p.id === c.id)) count++
      }
    }
  }
  return count
}
