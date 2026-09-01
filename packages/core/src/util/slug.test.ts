import { describe, expect, test } from "bun:test"
import { Slug } from "./slug"
import { AppRegistry } from "../app-registry"
import { Recipe } from "../recipe"

describe("Slug.from", () => {
  test("derives a folder-safe slug from a human title", () => {
    expect(Slug.from("Stock Prices")).toBe("stock-prices")
    expect(Slug.from("Hello, C!")).toBe("hello-c")
    expect(Slug.from("100 digits of π — Machin")).toBe("100-digits-of-machin")
    expect(Slug.from("  My Feature Branch!  ")).toBe("my-feature-branch")
  })

  // The cap is the whole reason this lives in one place. Every caller turns the result into a path
  // component (an app id, a recipe folder, a worktree directory + a `novaclaw/<name>` branch ref), and a
  // caller-supplied title arrives over HTTP. An uncapped copy is how a title becomes an unbounded path.
  test("caps at Slug.MAX so the result is always a legal path component", () => {
    const long = "a".repeat(500)
    expect(Slug.MAX).toBe(64)
    expect(Slug.from(long).length).toBe(64)
    expect(Slug.from("word ".repeat(200)).length).toBeLessThanOrEqual(64)
  })

  test("an explicit max is honoured, and only an explicit one lifts the cap", () => {
    expect(Slug.from("a".repeat(500), 10)).toBe("a".repeat(10))
  })

  // Both package-level names are now the same function. If either grows its own body again, this fails.
  test("AppRegistry.slugify and Recipe.slugify are this function, not copies of it", () => {
    expect(AppRegistry.slugify).toBe(Slug.from)
    expect(Recipe.slugify).toBe(Slug.from)
  })

  // A capped slug must still satisfy the pattern the recipe folder is validated against — the pattern's
  // {0,63} (1 + 63) and Slug.MAX (64) are the same bound, and they have to stay that way.
  test("a maximum-length slug is still a valid recipe slug", () => {
    const capped = Slug.from("z".repeat(500))
    expect(capped.length).toBe(Slug.MAX)
    expect(Recipe.isValidSlug(capped)).toBe(true)
  })
})
