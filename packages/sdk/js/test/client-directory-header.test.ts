import { describe, expect, test } from "bun:test"
import { createNovaclawClient } from "../src/v2/client"

/**
 * ⚠️ Lives in `test/`, not beside `client.ts`. `packages/sdk/js/tsconfig.json` pins `types` on
 * purpose so `src` stays BROWSER-FACING and cannot silently gain the Bun global; a `.test.ts` under
 * `src` imports `bun:test` and breaks the typecheck of every package that includes this one.
 *
 * The directory a request names must survive the trip, and the two carriers want DIFFERENT forms.
 *
 * `x-novaclaw-directory` is a header, which cannot hold arbitrary bytes, so it is percent-ENCODED
 * and `server/src/location.ts` decodes it. `location[directory]` is a query param, encoded by
 * `URLSearchParams` on the way out and decoded by the URL parser on the way in, so its value must be
 * RAW — the server reads it verbatim.
 *
 * The client moves the header into the query for GET/HEAD, which is exactly where those two forms
 * meet. Measured against a live instance on 2026-08-11: with a manually set header and no configured
 * directory, `GET /api/location` resolved to `C%3A%5CUsers%5C…` — the encoded string, used as a path.
 * A path containing a literal `%` is what makes this more than cosmetic, because then the corruption
 * is not even reversible by eye.
 */
const captureUrl = async (input: {
  readonly directory?: string
  readonly header?: string
  readonly method?: string
}) => {
  let seen: URL | undefined
  let seenHeader: string | null = null as string | null
  const client = createNovaclawClient({
    baseUrl: "http://localhost:4096",
    ...(input.directory === undefined ? {} : { directory: input.directory }),
    fetch: async (request: Request) => {
      seen = new URL(request.url)
      seenHeader = request.headers.get("x-novaclaw-directory")
      return new Response(JSON.stringify({ data: { directory: "x" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  } as never)
  // A REAL generated call, not a hand-rolled request: the rewrite lives in a request interceptor, so
  // anything that bypasses the generated path would be testing a different code route than ships.
  const options = input.header === undefined ? undefined : { headers: { "x-novaclaw-directory": input.header } }
  if ((input.method ?? "GET") === "GET") await client.v2.location.get(undefined, options as never)
  else await client.v2.session.create({} as never, options as never)
  return { url: seen!, header: seenHeader }
}

describe("the directory a request names survives the trip", () => {
  const paths = [
    ["a plain windows path", "C:\\Users\\nancy\\code"],
    ["a path holding a literal percent", "C:\\Users\\nancy\\weird%dir"],
    // The nastiest one: it LOOKS like valid percent-encoding, so a stray decode silently turns it
    // into "100 done" and every later comparison against the real folder fails for no visible reason.
    ["a path that looks percent-encoded", "C:\\Users\\nancy\\100%20done"],
  ] as const

  for (const [label, directory] of paths) {
    test(`${label}: a configured directory reaches the query RAW`, async () => {
      const { url } = await captureUrl({ directory })
      expect(url.searchParams.get("location[directory]")).toBe(directory)
      expect(url.searchParams.get("directory")).toBe(directory)
    })

    test(`${label}: a MANUALLY set header reaches the query raw too`, async () => {
      // The regression. `pick` returned the header verbatim when the client carried no directory of
      // its own, so an encoded header became an encoded query value and the server used it as a path.
      const { url } = await captureUrl({ header: encodeURIComponent(directory) })
      expect(url.searchParams.get("location[directory]")).toBe(directory)
    })

    test(`${label}: the header itself stays ENCODED on a POST`, async () => {
      // POST does not rewrite, so the header carrier is what the server sees — and it must still be
      // encoded, which is the form `location.ts` decodes.
      const { header, url } = await captureUrl({ directory, method: "POST" })
      expect(header).toBe(encodeURIComponent(directory))
      expect(url.searchParams.get("location[directory]")).toBeNull()
    })
  }

  test("a header that is not valid percent-encoding is passed through, not thrown on", async () => {
    // A bare `%` is not decodable. The client must not throw on it; the value is already raw.
    const { url } = await captureUrl({ header: "C:\\already%raw" })
    expect(url.searchParams.get("location[directory]")).toBe("C:\\already%raw")
  })
})
