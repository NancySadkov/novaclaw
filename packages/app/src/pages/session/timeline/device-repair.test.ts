import { describe, expect, mock, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { unpinSessionDevice } from "./device-repair"

describe("Device-pin repair", () => {
  test("removes the sparse Device override through the session update wire", async () => {
    const update = mock(async () => ({ data: {} }))
    const client = { v2: { session: { update } } }

    await unpinSessionDevice(client as never, "ses_test")

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ sessionID: "ses_test", device: null })
  })

  test("the structured repair reaches a visible transcript button", () => {
    const transcript = fs.readFileSync(
      path.resolve(import.meta.dir, "../../../../../session-ui/src/v2/components/native-transcript.tsx"),
      "utf8",
    )
    const page = fs.readFileSync(path.resolve(import.meta.dir, "../..", "session.tsx"), "utf8")

    expect(transcript).toContain('data-slot="native-notice-repair"')
    expect(transcript).toContain('props.repair?.type === "unpin-device"')
    expect(page).toContain("onUnpinDevice={unpinDevice}")
  })
})
