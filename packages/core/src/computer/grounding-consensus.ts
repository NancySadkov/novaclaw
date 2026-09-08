export * as ComputerGroundingConsensus from "./grounding-consensus"

import { ComputerCoordinates } from "./coordinates"
import type { ComputerProposal } from "./proposal"

/** Three is the smallest odd sample count that can outvote one wrong row. */
export const SAMPLE_COUNT = 3

/**
 * The acceptance UI's measured row pitch is 30 px at 1280×800. A cluster radius must stay below
 * half of that pitch or samples from adjacent rows become one vote. Scaling the short axis by 1/64
 * yields 12.5 px at that viewport, leaving a measured gap rather than relying on exact equality.
 */
export const radiusPixels = (viewport: ComputerCoordinates.Viewport): number =>
  Math.max(4, Math.floor(Math.min(viewport.width, viewport.height) / 64))

export type Result =
  | {
      readonly ok: true
      /** One point the model actually emitted — consensus never invents an averaged click. */
      readonly point: ComputerProposal.PointDraft
      readonly agreeing: number
      readonly radius: number
    }
  | { readonly ok: false; readonly reason: string }

interface Located {
  readonly source: ComputerProposal.PointDraft
  readonly pixel: ComputerCoordinates.Point
  readonly index: number
}

const squareDistance = (a: ComputerCoordinates.Point, b: ComputerCoordinates.Point): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))

const euclideanSquared = (a: ComputerCoordinates.Point, b: ComputerCoordinates.Point): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2

/**
 * Choose the densest pixel-space neighborhood, require a strict majority of ALL requested samples,
 * then return its medoid. Invalid/unreadable samples are absent from `points` but still count in
 * `requested`, so two failures can never turn one surviving coordinate into consensus.
 */
export function vote(input: {
  readonly points: ReadonlyArray<ComputerProposal.PointDraft>
  readonly requested?: number
  readonly space: ComputerCoordinates.Space
  readonly viewport: ComputerCoordinates.Viewport
}): Result {
  const requested = input.requested ?? SAMPLE_COUNT
  if (!Number.isInteger(requested) || requested < 1)
    return { ok: false, reason: `invalid requested sample count: ${requested}` }

  const located: Located[] = []
  for (const [index, source] of input.points.entries()) {
    const converted = ComputerCoordinates.toPixels(source, input.space, input.viewport)
    if (converted.ok) located.push({ source, pixel: converted.point, index })
  }
  const radius = radiusPixels(input.viewport)
  const neighborhoods = located.map((seed) => ({
    seed,
    members: located.filter((candidate) => squareDistance(seed.pixel, candidate.pixel) <= radius),
  }))
  neighborhoods.sort((a, b) => {
    if (a.members.length !== b.members.length) return b.members.length - a.members.length
    const scatter = (group: typeof a) =>
      group.members.reduce((sum, member) => sum + euclideanSquared(group.seed.pixel, member.pixel), 0)
    const byScatter = scatter(a) - scatter(b)
    return byScatter !== 0 ? byScatter : a.seed.index - b.seed.index
  })
  const winner = neighborhoods[0]
  if (winner === undefined || winner.members.length <= requested / 2)
    return {
      ok: false,
      reason: `no strict spatial majority: ${located.length}/${requested} readable sample(s), radius ${radius}px`,
    }

  const medoid = [...winner.members].sort((a, b) => {
    const score = (candidate: Located) =>
      winner.members.reduce((sum, member) => sum + euclideanSquared(candidate.pixel, member.pixel), 0)
    const byScore = score(a) - score(b)
    return byScore !== 0 ? byScore : a.index - b.index
  })[0]
  return { ok: true, point: medoid.source, agreeing: winner.members.length, radius }
}
