import { describe, expect, test } from "bun:test"
import { createReviewController, resolveReviewSource, type ReviewSource } from "./review-source"

describe("session review source", () => {
  test("keeps explicit workspace and branch choices", () => {
    expect(resolveReviewSource({ selected: "git", status: "busy", summaryComplete: false, hasVcs: true })).toEqual({
      mode: "git",
      kind: "workspace",
    })
    expect(resolveReviewSource({ selected: "branch", status: "idle", summaryComplete: true, hasVcs: true })).toEqual({
      mode: "branch",
      kind: "branch",
    })
  })

  test("uses live workspace changes while a chat recording is unsettled", () => {
    expect(resolveReviewSource({ selected: "turn", status: "busy", summaryComplete: true, hasVcs: true })).toEqual({
      mode: "git",
      kind: "live",
    })
    expect(resolveReviewSource({ selected: "turn", status: "idle", summaryComplete: false, hasVcs: true })).toEqual({
      mode: "git",
      kind: "live",
    })
  })

  test("reports incomplete honestly when no live VCS source exists", () => {
    expect(resolveReviewSource({ selected: "turn", status: "idle", summaryComplete: false, hasVcs: false })).toEqual({
      mode: "turn",
      kind: "incomplete",
    })
  })
})

describe("review controller", () => {
  test("keeps recorded and live sources, readiness, errors, counts, and revision in one boundary", () => {
    let source: ReviewSource = { mode: "turn", kind: "recorded" }
    let error: unknown
    const controller = createReviewController({
      source: () => source,
      recorded: () => ["recorded"],
      recordedCount: () => 1,
      recordedError: () => undefined,
      recordedRevision: () => "tree_2",
      vcs: () => ["live"],
      vcsFetched: () => true,
      vcsPending: () => false,
      vcsError: () => error,
    })

    expect(controller.diffs()).toEqual(["recorded"])
    expect(controller.revision()).toBe("tree_2")
    expect(controller.count()).toBe(1)

    source = { mode: "git", kind: "live" }
    expect(controller.diffs()).toEqual(["live"])
    expect(controller.revision()).toBeUndefined()

    error = new Error("offline")
    expect(controller.diffs()).toEqual([])
    expect(controller.error()).toBe(error)
  })

  test("saved changes keep their count while patches load and surface read failures", () => {
    let recorded: string[] | undefined
    let error: unknown
    const controller = createReviewController({
      source: () => ({ mode: "turn", kind: "recorded" }),
      recorded: () => recorded,
      recordedCount: () => 12,
      recordedError: () => error,
      recordedRevision: () => "tree",
      vcs: () => undefined,
      vcsFetched: () => false,
      vcsPending: () => false,
      vcsError: () => undefined,
    })
    expect(controller.count()).toBe(12)
    expect(controller.ready()).toBe(false)
    error = new Error("unreachable")
    expect(controller.ready()).toBe(true)
    expect(controller.error()).toBe(error)
    error = undefined
    recorded = []
    expect(controller.ready()).toBe(true)
    expect(controller.count()).toBe(0)
  })
})
