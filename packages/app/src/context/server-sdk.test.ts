import { describe, expect, test } from "bun:test"
import { resumeStreamAfterPageShow } from "./server-sdk"

// S7: the V1 `message.part.*` coalescing tests retired with the translated vocabulary — the
// stream carries raw `session.next.*` events, pushed to the frame-batched queue unmodified.

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})
