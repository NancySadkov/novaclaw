import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

test("application reads use queries that cannot suspend navigation", () => {
  const root = join(import.meta.dir, "..")
  const bypasses = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(root)]
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !path.includes(".test.") && path !== "utils/query.ts")
    .filter((path) =>
      /import\s*\{[^}]*\b(?:createQuery|useQuery|useQueries|useInfiniteQuery|createInfiniteQuery)\b[^}]*\}\s*from\s*["']@tanstack\/solid-query["']/s.test(
        readFileSync(join(root, path), "utf8"),
      ),
    )
  expect(bypasses).toEqual([])
})
