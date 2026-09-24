import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { refreshSourceOffer } from "./prepare-portable-git"

test("missing or stale source offers are restored without re-extracting the toolchain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "novaclaw-source-offer-"))
  try {
    const offer = Buffer.from("Complete corresponding source is available on request.\n")
    const file = path.join(root, "SOURCE-OFFER.txt")
    await refreshSourceOffer(root, offer)
    expect(await readFile(file)).toEqual(offer)
    await writeFile(file, "obsolete offer")
    await refreshSourceOffer(root, offer)
    expect(await readFile(file)).toEqual(offer)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
