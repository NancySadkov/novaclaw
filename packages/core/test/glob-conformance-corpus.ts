/**
 * The corpus `glob-match.test.ts` is checked against.
 *
 * ⚠️ `expected` was RECORDED from `minimatch@10.2.5` on 2026-09-03, the day the dependency was
 * replaced by `core/src/util/glob-match.ts`, with `bun test/glob-conformance-record.ts` — the
 * recorder is kept beside this file. So "equivalent" here means: for every pair below, the owned
 * matcher answers what minimatch answered. A pair whose answer this project deliberately changed
 * carries a `note` saying so; there are none today.
 *
 * The shapes: what `ignore.ts`, `watcher.ts` and `project-exclusion.ts` actually pass — `**` at
 * both ends, dotfiles under `dot: true`, braces, character classes, `?`, a trailing `/**`, a
 * `nocase` pair, an escaped literal — plus the classic gotchas (`**` matching zero segments, `*`
 * never crossing a separator, a dot segment under `dot: false`).
 */
export interface Case {
  readonly pattern: string
  readonly path: string
  readonly dot?: boolean
  readonly nocase?: boolean
}

export const CASES: ReadonlyArray<Case> = [
  // ignore.ts / watcher.ts shapes, always dot: true
  { pattern: "**/node_modules/**", path: "node_modules/x/y.js", dot: true },
  { pattern: "**/node_modules/**", path: "a/node_modules/x/y.js", dot: true },
  { pattern: "**/node_modules/**", path: "node_modules", dot: true },
  { pattern: "**/node_modules/**", path: "src/node_modulesx/y.js", dot: true },
  { pattern: "**/.git/**", path: ".git/HEAD", dot: true },
  { pattern: "**/*.md", path: ".forge/README.md", dot: true },
  { pattern: "**/*.md", path: "README.md", dot: true },
  { pattern: "**/*.md", path: "docs/a/b.md", dot: true },
  { pattern: "**/*.md", path: "docs/a/b.mdx", dot: true },
  { pattern: "*.txt", path: "file.txt", dot: true },
  { pattern: "*.txt", path: "dir/file.txt", dot: true },
  { pattern: "*.txt", path: "file.js", dot: true },
  { pattern: "**/*.js", path: "src/index.js", dot: true },
  { pattern: "**/*.js", path: "src/index.ts", dot: true },
  { pattern: ".*", path: ".gitignore", dot: true },
  { pattern: ".*", path: "gitignore", dot: true },
  { pattern: "*.{js,ts}", path: "file.js", dot: true },
  { pattern: "*.{js,ts}", path: "file.ts", dot: true },
  { pattern: "*.{js,ts}", path: "file.py", dot: true },
  { pattern: "*.{js,ts,tsx}", path: "a.tsx", dot: true },
  { pattern: "src/**", path: "src", dot: true },
  { pattern: "src/**", path: "src/a", dot: true },
  { pattern: "src/**", path: "src/a/b/c", dot: true },
  { pattern: "src/**", path: "srcx/a", dot: true },
  { pattern: "a/**/b", path: "a/b", dot: true },
  { pattern: "a/**/b", path: "a/x/b", dot: true },
  { pattern: "a/**/b", path: "a/x/y/b", dot: true },
  { pattern: "a/**/b", path: "a/x/y/bb", dot: true },
  { pattern: "a/*/b", path: "a/x/b", dot: true },
  { pattern: "a/*/b", path: "a/x/y/b", dot: true },
  { pattern: "a/*/b", path: "a/b", dot: true },
  { pattern: "file?.txt", path: "file1.txt", dot: true },
  { pattern: "file?.txt", path: "file12.txt", dot: true },
  { pattern: "file?.txt", path: "file/.txt", dot: true },
  { pattern: "[abc].txt", path: "b.txt", dot: true },
  { pattern: "[abc].txt", path: "d.txt", dot: true },
  { pattern: "[a-c].txt", path: "c.txt", dot: true },
  { pattern: "[!a-c].txt", path: "c.txt", dot: true },
  { pattern: "[!a-c].txt", path: "x.txt", dot: true },
  { pattern: "[^a-c].txt", path: "x.txt", dot: true },
  { pattern: "**/coverage/**", path: "packages/app/coverage/lcov.info", dot: true },
  { pattern: "**/*.log", path: "logs/.hidden/x.log", dot: true },
  { pattern: "**", path: "anything/at/all", dot: true },
  { pattern: "**", path: ".hidden/x", dot: true },
  { pattern: "*", path: ".hidden", dot: true },
  { pattern: "a.b", path: "a.b", dot: true },
  { pattern: "a.b", path: "axb", dot: true },
  { pattern: "a+b", path: "a+b", dot: true },
  { pattern: "a(b)", path: "a(b)", dot: true },
  { pattern: "a$b", path: "a$b", dot: true },
  { pattern: "a b", path: "a b", dot: true },
  { pattern: "dist/", path: "dist", dot: true },
  { pattern: "dist/", path: "dist/x", dot: true },
  // dot: false — the default in `glob` scans and in a bare minimatch
  { pattern: "**/*.md", path: ".forge/README.md", dot: false },
  { pattern: "**/*.md", path: "docs/README.md", dot: false },
  { pattern: "*", path: ".hidden", dot: false },
  { pattern: ".*", path: ".hidden", dot: false },
  { pattern: "**", path: ".hidden/x", dot: false },
  { pattern: "**", path: "a/.hidden/x", dot: false },
  { pattern: "**", path: "a/b", dot: false },
  { pattern: "a/*", path: "a/.b", dot: false },
  { pattern: "a/.*", path: "a/.b", dot: false },
  // project-exclusion shapes: `self` and `under`, anchored and unanchored, dot: true, nocase both ways
  { pattern: "**/secret.txt", path: "secret.txt", dot: true },
  { pattern: "**/secret.txt", path: "a/secret.txt", dot: true },
  { pattern: "**/secret.txt", path: "a/secret.txt/x", dot: true },
  { pattern: "**/secret.txt/**", path: "a/secret.txt/x", dot: true },
  { pattern: "**/secret.txt/**", path: "a/secret.txt", dot: true },
  { pattern: "secrets", path: "secrets", dot: true },
  { pattern: "secrets", path: "a/secrets", dot: true },
  { pattern: "secrets/**", path: "secrets/key.txt", dot: true },
  { pattern: "secrets/**", path: "secrets", dot: true },
  { pattern: "**/*.pem", path: "certs/.hidden/k.pem", dot: true },
  { pattern: "Secret.txt", path: "secret.txt", dot: true, nocase: true },
  { pattern: "Secret.txt", path: "secret.txt", dot: true, nocase: false },
  { pattern: "**/SECRETS/**", path: "a/secrets/k", dot: true, nocase: true },
  { pattern: "**/SECRETS/**", path: "a/secrets/k", dot: true, nocase: false },
  { pattern: "*.PEM", path: "k.pem", dot: true, nocase: true },
  { pattern: "[A-C].txt", path: "b.txt", dot: true, nocase: true },
  { pattern: "[A-C].txt", path: "b.txt", dot: true, nocase: false },
  // gotchas
  { pattern: "**/a", path: "a", dot: true },
  { pattern: "a/**", path: "a", dot: true },
  { pattern: "a/**/", path: "a/", dot: true },
  { pattern: "**/*", path: "a/b", dot: true },
  { pattern: "*/*", path: "a/b", dot: true },
  { pattern: "*/*", path: "a/b/c", dot: true },
  { pattern: "*", path: "a/b", dot: true },
  { pattern: "", path: "", dot: true },
  { pattern: "", path: "a", dot: true },
  { pattern: "a", path: "", dot: true },
  { pattern: "a//b", path: "a/b", dot: true },
  { pattern: "./a", path: "a", dot: true },
  { pattern: "a", path: "./a", dot: true },
  { pattern: "a/", path: "a/", dot: true },
  { pattern: "a/", path: "a", dot: true },
  { pattern: "**/*.{md,txt}", path: "x/y.txt", dot: true },
  { pattern: "**/*.{md,txt}", path: "x/y.rst", dot: true },
  { pattern: "{a,b}/c", path: "b/c", dot: true },
  { pattern: "{a,b}/c", path: "d/c", dot: true },
  { pattern: "a{1..3}", path: "a2", dot: true },
  { pattern: "[[:digit:]].txt", path: "5.txt", dot: true },
]
