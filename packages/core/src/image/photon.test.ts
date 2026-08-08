import { expect, test } from "bun:test"
import { Effect } from "effect"
import { make } from "./photon"

test("the shared image adapter reports decoded dimensions", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
  const dimensions = await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* make
      return yield* adapter.inspect("pixel.png", {
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      })
    }),
  )
  expect(dimensions).toEqual({ width: 1, height: 1 })
})
