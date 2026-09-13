import type { EdgeRow, MemoryRow } from "@/utils/memory-api"

export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface SpacePoint {
  readonly id: string
  readonly row: MemoryRow
  readonly position: Vec3
  readonly cluster: number
  readonly degree: number
  readonly color: readonly [number, number, number]
}

export interface SpaceCluster {
  readonly id: string
  readonly label: string
  readonly center: Vec3
  readonly count: number
  readonly members: readonly number[]
  readonly kinds: Readonly<Record<string, number>>
}

export interface SpaceEdge {
  readonly from: number
  readonly to: number
  readonly type: string
}

export interface MemorySpace {
  readonly points: readonly SpacePoint[]
  readonly clusters: readonly SpaceCluster[]
  readonly edges: readonly SpaceEdge[]
}

export type DetailLevel = "atlas" | "systems" | "memories"

export const MIN_SPACE_ZOOM = 0.65
export const MAX_SPACE_ZOOM = 8
export const DEFAULT_SPACE_ZOOM = 0.9

export function detailLevel(zoom: number): DetailLevel {
  if (zoom < 1.55) return "atlas"
  if (zoom < 3.35) return "systems"
  return "memories"
}

export const detailLabel = (level: DetailLevel): string =>
  level === "atlas" ? "Atlas" : level === "systems" ? "Systems" : "Memories"

const COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  entity: [0.55, 0.36, 0.96],
  episode: [0.13, 0.83, 0.93],
  claim: [0.2, 0.83, 0.6],
  passage: [0.66, 0.52, 0.59],
  source: [0.38, 0.65, 0.98],
}
const FALLBACK_COLOR = [0.73, 0.66, 0.75] as const

/** Unknown future kinds remain visible; adding a kind never requires adding a UI switch first. */
export const colorForKind = (kind: string): readonly [number, number, number] => COLORS[kind] ?? FALLBACK_COLOR

export function cssColor(color: readonly [number, number, number], alpha = 1): string {
  return `rgba(${color.map((channel) => Math.round(channel * 255)).join(",")},${alpha})`
}

function hash32(value: string, salt = 0): number {
  let h = (0x811c9dc5 ^ salt) >>> 0
  for (let index = 0; index < value.length; index++) {
    h ^= value.charCodeAt(index)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const hash01 = (value: string, salt = 0): number => hash32(value, salt) / 0xffffffff

class DisjointSet {
  private readonly parent: number[]
  private readonly rank: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index)
    this.rank = Array.from({ length: size }, () => 0)
  }

  find(value: number): number {
    const parent = this.parent[value]!
    if (parent === value) return value
    const root = this.find(parent)
    this.parent[value] = root
    return root
  }

  union(left: number, right: number): void {
    let a = this.find(left)
    let b = this.find(right)
    if (a === b) return
    if (this.rank[a]! < this.rank[b]!) [a, b] = [b, a]
    this.parent[b] = a
    if (this.rank[a] === this.rank[b]) this.rank[a]! += 1
  }
}

interface ClusterDraft {
  readonly id: string
  readonly members: number[]
  readonly preferredLabel?: string
}

const displayName = (row: MemoryRow): string | undefined => {
  const name = row.name?.trim()
  if (name) return name
  const source = row.source?.trim()
  return source || undefined
}

function clusterLabel(rows: readonly MemoryRow[], preferred?: string): string {
  if (preferred) return preferred
  const labels = new Map<string, number>()
  for (const row of rows) {
    const label = displayName(row)
    if (label) labels.set(label, (labels.get(label) ?? 0) + 1)
  }
  const winner = [...labels].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
  if (winner) return winner
  const kinds = [...new Set(rows.map((row) => row.kind))]
  return kinds.length === 1 ? `${kinds[0]} memories` : "Connected memories"
}

function galaxyCenter(index: number, count: number): Vec3 {
  if (count === 1) return { x: 0, y: 0, z: 0 }
  const angle = index * Math.PI * (3 - Math.sqrt(5)) - Math.PI / 2
  const radius = 0.22 + 0.61 * Math.sqrt((index + 0.5) / count)
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius * 0.74,
    z: (hash01(`cluster:${index}`, 0x45d9f3b) - 0.5) * 0.72,
  }
}

function starPosition(row: MemoryRow, ordinal: number, count: number, center: Vec3): Vec3 {
  if (count === 1) return center
  const spread = Math.min(0.24, 0.065 + Math.sqrt(count) * 0.008)
  const radius = spread * Math.cbrt((ordinal + 0.7) / count)
  const theta = ordinal * Math.PI * (3 - Math.sqrt(5)) + hash01(row.id, 17) * 0.65
  const z = (hash01(row.id, 31) * 2 - 1) * spread * 0.78
  return {
    x: center.x + Math.cos(theta) * radius,
    y: center.y + Math.sin(theta) * radius,
    z: center.z + z,
  }
}

/**
 * Build a stable three-dimensional atlas in one bounded pass. There is no force simulation and no
 * animation loop: topology is grouped once, deterministic hashes place the stars, and WebGL owns
 * every subsequent draw. Unlinked imports are chunked into navigable galaxies rather than one
 * 500-point fog bank; the chunks assert no relationship and therefore invent no edges.
 */
export function buildMemorySpace(nodes: readonly MemoryRow[], edges: readonly EdgeRow[]): MemorySpace {
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id))
  const indexByID = new Map(ordered.map((row, index) => [row.id, index]))
  const degree = Array.from({ length: ordered.length }, () => 0)
  const disjoint = new DisjointSet(ordered.length)
  const validEdges: SpaceEdge[] = []

  for (const edge of edges) {
    const from = indexByID.get(edge.from)
    const to = indexByID.get(edge.to)
    if (from === undefined || to === undefined || from === to) continue
    disjoint.union(from, to)
    degree[from]! += 1
    degree[to]! += 1
    validEdges.push({ from, to, type: edge.type })
  }

  const connected = new Map<number, number[]>()
  const unlinked = new Map<string, number[]>()
  for (let index = 0; index < ordered.length; index++) {
    if (degree[index]! > 0) {
      const root = disjoint.find(index)
      const group = connected.get(root) ?? []
      group.push(index)
      connected.set(root, group)
      continue
    }
    const row = ordered[index]!
    const key = `${row.kind}\u0000${displayName(row) ?? "Unlinked"}`
    const group = unlinked.get(key) ?? []
    group.push(index)
    unlinked.set(key, group)
  }

  const drafts: ClusterDraft[] = []
  for (const members of connected.values()) {
    const ids = members.map((index) => ordered[index]!.id).sort()
    drafts.push({ id: `connected:${ids[0]}`, members })
  }
  const UNLINKED_CLUSTER_SIZE = 72
  for (const [key, members] of [...unlinked].sort(([left], [right]) => left.localeCompare(right))) {
    const base = key.split("\u0000")[1] || "Unlinked memories"
    for (let offset = 0; offset < members.length; offset += UNLINKED_CLUSTER_SIZE) {
      const part = members.slice(offset, offset + UNLINKED_CLUSTER_SIZE)
      const number = Math.floor(offset / UNLINKED_CLUSTER_SIZE) + 1
      const total = Math.ceil(members.length / UNLINKED_CLUSTER_SIZE)
      drafts.push({
        id: `unlinked:${hash32(key)}:${number}`,
        members: part,
        preferredLabel: total > 1 ? `${base} · ${number}` : base,
      })
    }
  }
  drafts.sort((left, right) => left.id.localeCompare(right.id))

  const clusterOf = Array.from({ length: ordered.length }, () => 0)
  const positions = Array.from({ length: ordered.length }, () => ({ x: 0, y: 0, z: 0 }) as Vec3)
  const clusters: SpaceCluster[] = drafts.map((draft, clusterIndex) => {
    const center = galaxyCenter(clusterIndex, drafts.length)
    const rows = draft.members.map((index) => ordered[index]!)
    const kinds: Record<string, number> = {}
    draft.members.forEach((member, ordinal) => {
      clusterOf[member] = clusterIndex
      positions[member] = starPosition(ordered[member]!, ordinal, draft.members.length, center)
      const kind = ordered[member]!.kind
      kinds[kind] = (kinds[kind] ?? 0) + 1
    })
    return {
      id: draft.id,
      label: clusterLabel(rows, draft.preferredLabel),
      center,
      count: draft.members.length,
      members: draft.members,
      kinds,
    }
  })

  return {
    points: ordered.map((row, index) => ({
      id: row.id,
      row,
      position: positions[index]!,
      cluster: clusterOf[index]!,
      degree: degree[index]!,
      color: colorForKind(row.kind),
    })),
    clusters,
    edges: validEdges,
  }
}
