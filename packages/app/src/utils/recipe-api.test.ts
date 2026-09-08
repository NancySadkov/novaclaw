import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { ServerConnection } from "@/context/server"
import { InstanceFetchError } from "@/utils/instance-fetch"
import { importRecipeArchive, RecipeArchiveError, recipeArchive } from "@/utils/recipe-api"

/**
 * **A failure that is MATERIALISED as a plausible artifact.**
 *
 * The recipe ZIP is the share: the promise of the folder transport is that everything an author had
 * travels to a stranger's machine. The download reader answered an absent body with an empty
 * `Uint8Array`, and zero bytes is a well-formed empty archive to everything downstream — it was
 * blobbed, named `<slug>.recipe.zip`, saved, and the page said *"Saved"*. So the failure did not go
 * unreported; it went out as a FILE. A user opens it a week later on another machine and concludes
 * their recipe is gone.
 *
 * That is worse than an unreported error and it is a different class from one, because the artifact
 * is the evidence a person reasons from. The rule this file pins is therefore about the reader and
 * not about any caller: **bytes that are not an archive never leave `recipe-api.ts`**, so the only
 * thing an export path can do with a failed transfer is name it.
 *
 * ⚠️ Asserted against the WIRE, never against a second copy of the reader's own opinion — each case
 * below is an actual `Response` a proxy or an older peer can send.
 */

const server: ServerConnection.HttpBase = { url: "http://instance.test:4096", password: "hunter2" }

/** A real, minimal ZIP prologue — `PK` plus a local file header. */
const ZIP = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00)

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
})

const answering = (response: Response) => {
  globalThis.fetch = (() => Promise.resolve(response)) as unknown as typeof globalThis.fetch
}

describe("downloading a recipe archive — an archive, or nothing at all", () => {
  test("a real body still produces the bytes, verbatim", async () => {
    answering(new Response(ZIP, { status: 200, headers: { "content-type": "application/zip" } }))
    expect(await recipeArchive(server, "hello-c")).toEqual(ZIP)
  })

  test("🔴 a 200 with NO BODY is a named failure and produces no bytes", async () => {
    // The exact answer a proxy, or a peer on an older build, sends for a route it does not have.
    answering(new Response(null, { status: 200, headers: { "content-type": "application/zip" } }))
    const error = await recipeArchive(server, "hello-c").then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(RecipeArchiveError)
    expect((error as RecipeArchiveError).fault).toBe("empty")
    expect((error as RecipeArchiveError).slug).toBe("hello-c")
    // The sentence a person reads has to say that nothing was saved — "empty archive" would send
    // them looking for the file.
    expect((error as RecipeArchiveError).message).toMatch(/nothing was saved/i)
  })

  test("a 200 whose body reads ZERO BYTES is the same failure", async () => {
    // Distinct from the case above at the transport level: here there IS a stream and it is empty,
    // which is what a truncated proxy response looks like. Both must land on one answer.
    answering(new Response("", { status: 200, headers: { "content-type": "application/zip" } }))
    await expect(recipeArchive(server, "hello-c")).rejects.toBeInstanceOf(RecipeArchiveError)
  })

  test("🔴 a 200 carrying something that is NOT a ZIP never reaches the disk either", async () => {
    // A captive portal or an auth proxy answering 200 with an HTML notice is the second way this
    // path can hand a user a file full of the wrong thing under a `.recipe.zip` name.
    answering(
      new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } }),
    )
    const error = await recipeArchive(server, "hello-c").then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(RecipeArchiveError)
    expect((error as RecipeArchiveError).fault).toBe("not-a-zip")
  })

  test("a non-2xx is the seam's own fault, not a silent empty file", async () => {
    answering(new Response("no such recipe", { status: 404 }))
    await expect(recipeArchive(server, "gone")).rejects.toBeInstanceOf(InstanceFetchError)
  })

  test("negative control — the pre-fix reader would have passed every assertion above", async () => {
    // What the code did: `if (!reader) return new Uint8Array()`. Reproduced here so the claim "this
    // test would have been green before" is demonstrated rather than asserted in a comment.
    // `Uint8Array<ArrayBuffer>`, not the bare alias: the default parameter is ArrayBufferLike, which
    // admits SharedArrayBuffer and so is not a BlobPart — and the point of this control is that the
    // pre-fix result WAS blobbable.
    const preFix = async (response: Response): Promise<Uint8Array<ArrayBuffer>> => {
      const reader = response.body?.getReader()
      if (!reader) return new Uint8Array()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        chunks.push(next.value)
      }
      const out = new Uint8Array(new ArrayBuffer(total))
      let at = 0
      for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.byteLength
      }
      return out
    }
    const bodyless = await preFix(new Response(null, { status: 200 }))
    // Zero bytes, no error — and a Blob of it is a file the browser will happily save.
    expect(bodyless.byteLength).toBe(0)
    expect(new Blob([bodyless], { type: "application/zip" }).size).toBe(0)
  })
})

describe("uploading one — the same refusal, facing the other way", () => {
  test("an empty file is refused here rather than posted for the server to refuse", async () => {
    globalThis.fetch = (() => {
      throw new Error("importRecipeArchive must not reach the network with an empty file")
    }) as unknown as typeof globalThis.fetch
    await expect(importRecipeArchive(server, new Uint8Array())).rejects.toBeInstanceOf(RecipeArchiveError)
  })

  test("a file that is not a ZIP is refused, and a real one is sent", async () => {
    globalThis.fetch = (() => {
      throw new Error("importRecipeArchive must not reach the network with a non-ZIP file")
    }) as unknown as typeof globalThis.fetch
    await expect(importRecipeArchive(server, Uint8Array.of(0x7b, 0x22, 0x61))).rejects.toBeInstanceOf(
      RecipeArchiveError,
    )
    // …and the guard is not simply refusing everything.
    answering(new Response(JSON.stringify({ slug: "arrived" }), { status: 200 }))
    expect((await importRecipeArchive(server, ZIP)).slug).toBe("arrived")
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * **The ratchet, because the class is bigger than this file.**
 *
 * `instanceFetch` already refuses *"a 2xx that promised a body and sent none"*, which is why the
 * three other export paths in this app (identity backup, memory export, memory clear's auto-backup)
 * cannot materialise an empty artifact — they inherit that guard by going through it. A caller that
 * passes its own reader to `instanceFetchResponse` opts OUT of it, silently, and gets to decide for
 * itself what an absent body means. That opt-out is the door this defect came through, and the next
 * custom reader will be written by somebody who never saw this file.
 *
 * So every custom-reader call site is pinned by name with the answer it gives to *"what if there is
 * no body?"*. A new one fails here; a pin the tree no longer justifies fails here too.
 */
const ROOT = path.resolve(import.meta.dir, "..")

/** Source with comments stripped — a doc-comment naming the helper is prose, not a call site. */
function code(file: string): string {
  return fs
    .readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function callSites(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        const relative = path.relative(ROOT, full).split(path.sep).join("/")
        // The declaration itself is not a call site.
        if (relative === "utils/instance-fetch.ts") continue
        if (code(relative).includes("instanceFetchResponse(")) out.push(relative)
      }
    }
  }
  walk(ROOT)
  return out.sort()
}

/** Every file that reads a response itself, and why an absent body cannot become an artifact there. */
const CUSTOM_READERS: Record<string, string> = {
  "apps/agent-portrait.ts":
    "Reads an authenticated image Blob. An empty or non-image body THROWS before an object URL is made.",
  "apps/persisted.ts":
    "DELETE answers `true` from `res.ok` and reads no body at all — a 204 (or a proxy's 200) is the " +
    "success, and nothing is written anywhere.",
  "utils/diagnostic-export.ts":
    "Bounded text read for Export logs. An absent body THROWS; the one caller degrades to " +
    "\"exporting desktop records only\", so no file claims an instance section it never received.",
  "utils/recipe-api.ts": "Refuses an empty or non-ZIP body outright — the tests above.",
}

describe("no second reader may quietly decide that no body means empty", () => {
  test("every instanceFetchResponse caller is pinned with its no-body answer", () => {
    const found = callSites()
    // A reader that finds nothing would make every comparison below a tautology.
    expect(found.length).toBeGreaterThanOrEqual(3)
    expect(found).toContain("utils/recipe-api.ts")
    expect(
      { unpinned: found.filter((file) => CUSTOM_READERS[file] === undefined) },
      [
        "A file passes its own reader to `instanceFetchResponse`, so it does NOT inherit the seam's",
        "empty-body guard and decides for itself what an absent body means.",
        "Say what it does when the body is missing, and add it here — or make it throw.",
      ].join("\n"),
    ).toEqual({ unpinned: [] })
    expect(
      { stale: Object.keys(CUSTOM_READERS).filter((file) => !found.includes(file)) },
      "A pinned file no longer calls `instanceFetchResponse`. Delete its line.",
    ).toEqual({ stale: [] })
  })

  test("the reader actually bites (negative control)", () => {
    // Comment-stripping is what stops this counting the prose above, and the paragraph in
    // `apps/persisted.ts` that names the helper twice before calling it once.
    expect(code("utils/recipe-api.ts")).not.toContain("This file's old")
    expect(code("apps/persisted.ts").match(/instanceFetchResponse\(/g)).toHaveLength(1)
    expect(callSites()).not.toContain("utils/instance-fetch.ts")
  })
})
