import { expect, test } from "bun:test"
import { EMBED_READY, EMBED_WRITE, htmlEmbedBootstrap, isEmbedReady } from "./html-embed-bootstrap"

test("the bootstrap announces itself and waits to be written", () => {
  const html = htmlEmbedBootstrap()
  expect(html).toContain(EMBED_READY)
  expect(html).toContain(EMBED_WRITE)
  expect(html).toContain("document.write")
})

test("🔴 the bootstrap carries NO policy of its own", () => {
  // The policy arrives as a response header — that is the entire reason this is a served document
  // and not a srcdoc. A meta here would be a second copy to drift, and worse, it would still be
  // there if the header seam ever silently stopped applying, hiding that failure.
  expect(htmlEmbedBootstrap()).not.toContain("Content-Security-Policy")
})

test("🔴 it accepts a body only from its own embedder", () => {
  // Identity of the sending window, not its origin: the frame is sandboxed without
  // `allow-same-origin`, so every such frame in the page posts from "null" and origin cannot tell
  // ours from anyone else's.
  expect(htmlEmbedBootstrap()).toContain("event.source !== window.parent")
})

test("isEmbedReady accepts only the real announcement from the real frame", () => {
  const frame = { name: "the frame" }
  const other = { name: "someone else" }
  expect(isEmbedReady({ type: EMBED_READY }, frame, frame)).toBe(true)
  // Right message, wrong window.
  expect(isEmbedReady({ type: EMBED_READY }, other, frame)).toBe(false)
  // Right window, wrong message.
  expect(isEmbedReady({ type: "something-else" }, frame, frame)).toBe(false)
  expect(isEmbedReady("a string", frame, frame)).toBe(false)
  expect(isEmbedReady(null, frame, frame)).toBe(false)
})

test("🔴 an absent frame never matches an absent source", () => {
  // The control for the identity check. `source !== frame` alone says TRUE for two undefineds,
  // which is exactly the state a torn-down embed is in — and would let any message through.
  expect(isEmbedReady({ type: EMBED_READY }, undefined, undefined)).toBe(false)
  expect(isEmbedReady({ type: EMBED_READY }, null, null)).toBe(false)
})
