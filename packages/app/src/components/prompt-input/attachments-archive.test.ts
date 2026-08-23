import { describe, expect, test } from "bun:test"
import { attachmentMime } from "./files"

/**
 * ATTACHING A ZIP (owner, 2026-08-23).
 *
 * 🔴 The refusal happened HERE, at the picker, before anything downstream could open the archive.
 * A zip's first 4 KB are compressed bytes, so the textual sniff at the bottom of `attachmentMime`
 * rejected them and the composer said "that file type is not supported" — the user's project never
 * left the browser.
 */
const file = (name: string, type: string, bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])) =>
  new File([bytes], name, { type })

describe("attachmentMime — archives", () => {
  test("🔴 a zip is accepted, by mime and by extension", async () => {
    expect(await attachmentMime(file("project.zip", "application/zip"))).toBe("application/zip")
    expect(await attachmentMime(file("project.zip", "application/x-zip-compressed"))).toBe(
      "application/x-zip-compressed",
    )
    // Chrome and the OS file picker both report octet-stream for plenty of archives.
    expect(await attachmentMime(file("project.zip", "application/octet-stream"))).toBe("application/zip")
    expect(await attachmentMime(file("project.zip", ""))).toBe("application/zip")
  })

  test("the other containers are accepted too, so the refusal can be a SENTENCE not a rejection", async () => {
    expect(await attachmentMime(file("src.tar.gz", "application/gzip"))).toBe("application/gzip")
    expect(await attachmentMime(file("src.tar", "application/octet-stream"))).toBe("application/x-tar")
    expect(await attachmentMime(file("lib.whl", "application/octet-stream"))).toBe("application/zip")
  })

  test("⚠️ a NAMED mime still wins over the extension", async () => {
    // A browser that says image/png for a file called notes.zip is describing the BYTES, and it is
    // right. Taking the archive path here would refuse an image a vision model could have read.
    expect(await attachmentMime(file("notes.zip", "image/png"))).toBe("image/png")
  })

  test("a binary that is NOT an archive is still refused", async () => {
    const noise = new Uint8Array([0x00, 0x01, 0x02, 0x00, 0x03])
    expect(await attachmentMime(new File([noise], "mystery.bin", { type: "application/octet-stream" }))).toBeUndefined()
  })
})
