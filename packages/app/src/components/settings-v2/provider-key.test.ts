import { describe, expect, test } from "bun:test"
import { mergeProviderKey } from "./provider-key"

/**
 * SEEING AND CHANGING A PROVIDER'S API KEY.
 *
 * Owner's ask, 2026-08-24: model configuration must let a key be seen and changed. Before this the
 * key could only be set once, in the ADD dialog — `dialog-model-config` had no key field at all, so
 * "which key is this provider using?" had no answer anywhere in the product, and a rotated key meant
 * deleting the provider and rebuilding it.
 *
 * What is pinned here is the write rule, because each arm of it fails quietly.
 */

describe("what a save writes for the provider key", () => {
  test("unchanged means DON'T REWRITE — the same object comes back", () => {
    // 🔴 Not merely an optimisation. A fresh object every save rewrites the provider layer on every
    // unrelated edit, and a config write disposes instances — so a no-op save would cost far more
    // than a no-op.
    const request = { body: { apiKey: "sk-live", temperature: 0.2 } }
    expect(mergeProviderKey({ request, stored: "sk-live", next: "sk-live" })).toBe(request)
  })

  test("a changed key lands at request.body.apiKey", () => {
    expect(mergeProviderKey({ request: { body: { apiKey: "old" } }, stored: "old", next: "new" })).toEqual({
      body: { apiKey: "new" },
    })
  })

  test("🔴 an empty field CLEARS it — written as a value, never omitted", () => {
    // The config store patch-merges: omitting `apiKey` PRESERVES it, so "delete my key" would
    // silently do nothing and the user would keep authenticating with a key they thought was gone.
    const merged = mergeProviderKey({ request: { body: { apiKey: "old" } }, stored: "old", next: "" })
    expect(merged?.body).toHaveProperty("apiKey", "")
  })

  test("other request-body fields survive a key change", () => {
    // `request.body` also carries the provider's request overlay. Replacing the body wholesale would
    // drop sampling defaults a user had configured, for an unrelated edit.
    expect(
      mergeProviderKey({
        request: { body: { apiKey: "old", temperature: 0.7, top_p: 0.9 } },
        stored: "old",
        next: "new",
      })?.body,
    ).toEqual({ apiKey: "new", temperature: 0.7, top_p: 0.9 })
  })

  test("a provider that never had a request gains one, without inventing other fields", () => {
    expect(mergeProviderKey({ request: undefined, stored: "", next: "sk-first" })).toEqual({
      body: { apiKey: "sk-first" },
    })
  })

  test("non-body request fields are preserved", () => {
    const merged = mergeProviderKey({
      request: { headers: { "x-org": "acme" }, body: { apiKey: "old" } },
      stored: "old",
      next: "new",
    })
    expect(merged?.["headers"]).toEqual({ "x-org": "acme" })
  })

  test("NEGATIVE CONTROL: a rule that always returned the original would be caught", () => {
    // Without this, `mergeProviderKey = (i) => i.request` passes the first test and looks fine.
    expect(mergeProviderKey({ request: { body: { apiKey: "old" } }, stored: "old", next: "new" })).not.toEqual({
      body: { apiKey: "old" },
    })
  })
})
