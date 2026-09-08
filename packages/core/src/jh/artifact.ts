export * as JhArtifact from "./artifact"

// jh — the content-addressed artifact store (jh.md §6, the Tree/State Store as a keyed blackboard).
// Leaf steps commit their declared `produces` here; the Context Manager (Phase 5) resolves a step's
// `consumes` against it. Synchronous, Map-backed, latest-write-wins per id; content is hashed
// (sha256) so identical content is identical by hash — the memoization key jh.md §6b keeps for later.

import type { JhStep } from "./step"
import { Hash } from "../util/hash"

export interface Stored {
  readonly id: string
  readonly type: JhStep.ArtifactType
  readonly hash: string
  readonly content: string
}

export interface Store {
  readonly put: (ref: JhStep.ArtifactRef, content: string) => Stored // overwrite = latest wins
  readonly get: (id: string) => Stored | undefined
  readonly has: (id: string) => boolean
  readonly ids: () => ReadonlySet<string>
  readonly snapshot: () => ReadonlyArray<Stored> // for persistence / round-trip
}

export function memory(seed?: ReadonlyArray<Stored>): Store {
  const map = new Map<string, Stored>()
  if (seed) for (const s of seed) map.set(s.id, s)
  return {
    put: (ref, content) => {
      const stored: Stored = { id: ref.id, type: ref.type, hash: Hash.sha256(content), content }
      map.set(ref.id, stored)
      return stored
    },
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    ids: () => new Set(map.keys()),
    snapshot: () => [...map.values()],
  }
}
