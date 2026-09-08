export namespace Slug {
  const ADJECTIVES = [
    "brave",
    "calm",
    "clever",
    "cosmic",
    "crisp",
    "curious",
    "eager",
    "gentle",
    "glowing",
    "happy",
    "hidden",
    "jolly",
    "kind",
    "lucky",
    "mighty",
    "misty",
    "neon",
    "nimble",
    "playful",
    "proud",
    "quick",
    "quiet",
    "shiny",
    "silent",
    "stellar",
    "sunny",
    "swift",
    "tidy",
    "witty",
  ] as const

  const NOUNS = [
    "cabin",
    "cactus",
    "canyon",
    "circuit",
    "comet",
    "eagle",
    "engine",
    "falcon",
    "forest",
    "garden",
    "harbor",
    "island",
    "knight",
    "lagoon",
    "meadow",
    "moon",
    "mountain",
    "nebula",
    "orchid",
    "otter",
    "panda",
    "pixel",
    "planet",
    "river",
    "rocket",
    "sailor",
    "squid",
    "star",
    "tiger",
    "wizard",
    "wolf",
  ] as const

  export function create() {
    return [
      ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)],
      NOUNS[Math.floor(Math.random() * NOUNS.length)],
    ].join("-")
  }

  /**
   * The default length cap. Every slug this function produces doubles as a path component — an app id,
   * a recipe folder, a worktree directory — so the cap is a containment property, not cosmetics: an
   * uncapped component derived from a title blows the Windows 260-character full-path limit and fails
   * at `mkdir` with an error that names the path, never the title that produced it.
   */
  export const MAX = 64

  /**
   * Derive a folder-safe slug from a human string ("Hello, C!" -> "hello-c").
   *
   * ⚠️ Pass a different `max` only when the result is NOT a path component. Dropping the cap is what
   * made the worktree copy of this function produce unbounded directory names.
   */
  export function from(name: string, max: number = MAX): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
  }
}
