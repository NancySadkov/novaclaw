import { describe, expect, test } from "bun:test"
import { ModelPrefixCache } from "./model-prefix-cache"

describe("model prefix cache", () => {
  test("measures UTF-8 bytes rather than JavaScript characters", () => {
    expect(ModelPrefixCache.commonPrefixBytes("a😀x", "a😀y")).toBe(5)
  })

  test("estimates cached tokens from the longest exact byte prefix", () => {
    expect(
      ModelPrefixCache.compare(
        [
          { prompt: "ab0000", bytes: 6, expiresAt: 1 },
          { prompt: "abcxyz", bytes: 6, expiresAt: 1 },
        ],
        "abcdef",
        60,
      ),
    ).toEqual({ promptBytes: 6, matchedPrefixBytes: 3, expectedCachedTokens: 30, comparedEntries: 2 })
    expect(ModelPrefixCache.DEFAULT_TTL_MINUTES).toBe(5)
  })
})
