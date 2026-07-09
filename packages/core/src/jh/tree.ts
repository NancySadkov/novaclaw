export * as JhTree from "./tree"

// jh — the harness-owned Step tree (jh.md §3, §6c). Nodes are keyed by deterministic path ids
// ("root", "root.1", "root.1.2" — D5) the TREE assigns, never the model. Four statuses drive the
// depth-first eval: pending (awaiting introspection) → expanded (decomposed into children) or
// committed (leaf verified) / blocked. Every function is pure and returns a NEW Tree — the immutable
// discipline is what makes the append-only log / resume story (jh.md §6b) work.

import type { JhStep } from "./step"

export type Status = "pending" | "expanded" | "committed" | "blocked"

export interface Node {
  readonly id: JhStep.StepID
  readonly parent: JhStep.StepID | undefined
  readonly draft: Omit<JhStep.StepDraft, "substeps">
  readonly children: ReadonlyArray<JhStep.StepID>
  readonly status: Status
  readonly depth: number // root = 0
}

export interface Tree {
  readonly root: JhStep.StepID
  readonly nodes: ReadonlyMap<string, Node>
}

export class AttachError {
  constructor(
    readonly reason: "unknown_parent" | "already_expanded" | "max_depth" | "empty",
    readonly detail: string,
  ) {}
}

const asID = (s: string): JhStep.StepID => s as JhStep.StepID

export const ROOT_ID = asID("root")

export function create(rootDraft: Omit<JhStep.StepDraft, "substeps">): Tree {
  const root: Node = { id: ROOT_ID, parent: undefined, draft: rootDraft, children: [], status: "pending", depth: 0 }
  return { root: ROOT_ID, nodes: new Map([[ROOT_ID, root]]) }
}

/** Recursively materialize a draft (and any nested substeps) into `out`, keyed by path id. Sets a
 *  node "expanded" when it carries substeps, "pending" when it is a leaf. Returns an AttachError if
 *  any node would exceed maxDepth (checked before it is created). */
function buildSubtree(
  out: Map<string, Node>,
  draft: JhStep.StepDraft,
  id: JhStep.StepID,
  parent: JhStep.StepID,
  depth: number,
  maxDepth: number,
): AttachError | undefined {
  if (depth > maxDepth) return new AttachError("max_depth", `node ${id} at depth ${depth} exceeds maxDepth ${maxDepth}`)
  const { substeps, ...rest } = draft
  const kids = substeps ?? []
  const childIDs: JhStep.StepID[] = []
  for (let i = 0; i < kids.length; i++) {
    const childID = asID(`${id}.${i + 1}`)
    const err = buildSubtree(out, kids[i]!, childID, id, depth + 1, maxDepth)
    if (err) return err
    childIDs.push(childID)
  }
  out.set(id, { id, parent, draft: rest, children: childIDs, status: kids.length > 0 ? "expanded" : "pending", depth })
  return undefined
}

/**
 * Attach a decomposition under `parentID`. Child ids are `${parentID}.${i+1}` in order. Drafts may
 * carry nested substeps — attach them recursively (compound nodes become "expanded", leaves
 * "pending"). The parent transitions pending → expanded. Fails on an unknown/non-pending parent, empty
 * drafts, or any resulting node whose depth exceeds maxDepth. Attach is once-only per node (a
 * non-pending parent → already_expanded), which keeps path ids stable.
 */
export function attach(
  tree: Tree,
  parentID: JhStep.StepID,
  drafts: ReadonlyArray<JhStep.StepDraft>,
  maxDepth: number,
): Tree | AttachError {
  const parent = tree.nodes.get(parentID)
  if (!parent) return new AttachError("unknown_parent", parentID)
  if (parent.status !== "pending") return new AttachError("already_expanded", `${parentID} is ${parent.status}`)
  if (drafts.length === 0) return new AttachError("empty", `${parentID} got no drafts`)

  const temp = new Map<string, Node>()
  const childIDs: JhStep.StepID[] = []
  for (let i = 0; i < drafts.length; i++) {
    const childID = asID(`${parentID}.${i + 1}`)
    const err = buildSubtree(temp, drafts[i]!, childID, parentID, parent.depth + 1, maxDepth)
    if (err) return err
    childIDs.push(childID)
  }

  const nodes = new Map(tree.nodes)
  nodes.set(parentID, { ...parent, status: "expanded", children: childIDs })
  for (const [k, v] of temp) nodes.set(k, v)
  return { root: tree.root, nodes }
}

/** Dynamic AST growth: append ONE new pending child to a node (owner's "the list holding it gets extended
 *  with an additional node"). The parent becomes/stays "expanded" — so a COMMITTED node reopens when it
 *  gains a fresh child (used to extend a task whose goal-check failed with one more fix step). The new
 *  child id is `${parentID}.${children.length + 1}` (stable — never reuses a prior index). */
export function appendChild(tree: Tree, parentID: JhStep.StepID, draft: JhStep.StepDraft, maxDepth: number): Tree | AttachError {
  const parent = tree.nodes.get(parentID)
  if (!parent) return new AttachError("unknown_parent", parentID)
  const childID = asID(`${parentID}.${parent.children.length + 1}`)
  const temp = new Map<string, Node>()
  const err = buildSubtree(temp, draft, childID, parentID, parent.depth + 1, maxDepth)
  if (err) return err
  const nodes = new Map(tree.nodes)
  nodes.set(parentID, { ...parent, status: "expanded", children: [...parent.children, childID] })
  for (const [k, v] of temp) nodes.set(k, v)
  return { root: tree.root, nodes }
}

export function get(tree: Tree, id: JhStep.StepID): Node | undefined {
  return tree.nodes.get(id)
}

/** Replace a node's draft (the engine stores the model-filled schema back onto the node). No-op tree
 *  if the id is unknown. */
export function fill(tree: Tree, id: JhStep.StepID, draft: Omit<JhStep.StepDraft, "substeps">): Tree {
  const node = tree.nodes.get(id)
  if (!node) return tree
  const nodes = new Map(tree.nodes)
  nodes.set(id, { ...node, draft })
  return { root: tree.root, nodes }
}

export function setStatus(tree: Tree, id: JhStep.StepID, status: Status): Tree {
  const node = tree.nodes.get(id)
  if (!node) return tree
  const nodes = new Map(tree.nodes)
  nodes.set(id, { ...node, status })
  return { root: tree.root, nodes }
}

/** Preorder walk; the first node with status "pending". Descends INTO expanded nodes (they are not
 *  themselves pending) but never into committed or blocked subtrees. Left-to-right sibling order gives
 *  the implied execution sequencing. */
export function nextPending(tree: Tree): Node | undefined {
  const walk = (id: JhStep.StepID): Node | undefined => {
    const node = tree.nodes.get(id)
    if (!node) return undefined
    if (node.status === "pending") return node
    if (node.status === "expanded") {
      for (const childID of node.children) {
        const found = walk(childID)
        if (found) return found
      }
    }
    return undefined // committed / blocked → do not descend
  }
  return walk(tree.root)
}

export function children(tree: Tree, id: JhStep.StepID): ReadonlyArray<Node> {
  const node = tree.nodes.get(id)
  if (!node) return []
  return node.children.map((cid) => tree.nodes.get(cid)).filter((n): n is Node => n !== undefined)
}

/** True iff the node has children and every one is committed (the bubble-up trigger). A leaf (no
 *  children) is false — leaves commit through the atomic path, not by bubbling. */
export function allChildrenCommitted(tree: Tree, id: JhStep.StepID): boolean {
  const node = tree.nodes.get(id)
  if (!node || node.children.length === 0) return false
  return node.children.every((cid) => tree.nodes.get(cid)?.status === "committed")
}

export function size(tree: Tree): number {
  return tree.nodes.size
}

/** Ancestor chain root→…→parent (excludes the node itself), root first. */
export function ancestors(tree: Tree, id: JhStep.StepID): ReadonlyArray<Node> {
  const out: Node[] = []
  let cur = tree.nodes.get(id)
  while (cur && cur.parent !== undefined) {
    const p = tree.nodes.get(cur.parent)
    if (!p) break
    out.push(p)
    cur = p
  }
  return out.reverse()
}
