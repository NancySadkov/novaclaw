import { describe, expect, test } from "bun:test"
import type { SessionChangeDiff } from "@novaclaw/sdk/v2"
import { diffs } from "./diffs"

const item = {
  file: "src/app.ts",
  patch: "@@ -1 +1 @@\n-old\n+new\n",
  additions: 1,
  deletions: 1,
  status: "modified",
} satisfies SessionChangeDiff

describe("diffs", () => {
  test("keeps valid arrays", () => {
    expect(diffs([item])).toEqual([item])
  })

  test("wraps a single diff object", () => {
    expect(diffs(item)).toEqual([item])
  })

  test("reads keyed diff objects", () => {
    expect(diffs({ a: item })).toEqual([item])
  })

  test("drops invalid entries", () => {
    expect(
      diffs([
        item,
        { file: "src/bad.ts", additions: "1", deletions: 1 },
        { patch: item.patch, additions: 1, deletions: 1 },
      ]),
    ).toEqual([item])
  })

  test("preserves metadata-only entries without patch text", () => {
    const metadataOnly = {
      file: "assets/logo.png",
      additions: 0,
      deletions: 0,
      status: "modified",
      patchUnavailableReason: "binary",
    } as const
    expect(diffs([metadataOnly])).toEqual([metadataOnly])
  })
})
