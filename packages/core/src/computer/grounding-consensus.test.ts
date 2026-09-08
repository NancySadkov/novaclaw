import { describe, expect, test } from "bun:test"
import { ComputerGroundingConsensus as Consensus } from "./grounding-consensus"

const viewport = { width: 1280, height: 800 }
const vote = (points: ReadonlyArray<{ readonly x: number; readonly y: number }>, requested = 3) =>
  Consensus.vote({ points, requested, space: "pixels", viewport })

describe("C2 spatial grounding consensus", () => {
  test("two nearby samples outvote one distant sample and return an emitted point", () => {
    const points = [{ x: 400, y: 200 }, { x: 407, y: 204 }, { x: 900, y: 700 }]
    const result = vote(points)
    expect(result).toEqual({ ok: true, point: points[0], agreeing: 2, radius: 12 })
  })

  test("the measured 30 px adjacent row stays a different vote", () => {
    const correct = { x: 500, y: 300 }
    const result = vote([correct, { x: 506, y: 304 }, { x: 503, y: 330 }])
    expect(result.ok && result.point).toEqual(correct)
  })

  test("three scattered samples abstain instead of averaging into an invented click", () => {
    expect(vote([{ x: 100, y: 100 }, { x: 500, y: 400 }, { x: 900, y: 700 }])).toEqual({
      ok: false,
      reason: "no strict spatial majority: 3/3 readable sample(s), radius 12px",
    })
  })

  test("unreadable or out-of-range replies still count against the requested majority", () => {
    expect(vote([{ x: 200, y: 200 }, { x: 2000, y: 2000 }])).toEqual({
      ok: false,
      reason: "no strict spatial majority: 1/3 readable sample(s), radius 12px",
    })
  })

  test("a tight three-way cluster chooses its deterministic medoid", () => {
    const middle = { x: 404, y: 403 }
    const result = vote([{ x: 400, y: 400 }, middle, { x: 409, y: 405 }])
    expect(result.ok && result.point).toEqual(middle)
  })
})
