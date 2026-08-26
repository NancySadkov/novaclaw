import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { FSUtil } from "@novaclaw/core/fs-util"
import { tmpdir } from "./fixture/tmpdir"

/**
 * 🔴 **Codex review NC-SEC-018 — a lexical containment check is a SPELLING check.**
 *
 * The Files HTTP mutations declared that their payload paths are relative to the routed directory
 * and that "nothing escapes the browsed root", and enforced it with `path.resolve` plus
 * `FSUtil.contains`: two strings compared. A cloned repository that ships `escape` as a directory
 * symlink — or, on Windows, a junction, which needs no privilege to create — makes
 * `escape/settings.json` resolve *lexically* inside the root while the write lands wherever the link
 * points. No `..`, no absolute path, no second routed root.
 *
 * These tests are about the primitive that fixes it. They create real links on the real filesystem,
 * because the whole property is about what the OS does with an ancestor and a string comparison
 * cannot observe that.
 *
 * ⚠️ **Windows creates the directory link as a JUNCTION.** `fs.symlink(..., "dir")` needs Developer
 * Mode or elevation there and would make this suite skip on the machine it most needs to run on;
 * `"junction"` needs neither and is the alias a repository would realistically carry. On POSIX the
 * type argument is ignored and an ordinary symlink is made.
 */
const DIR_LINK = process.platform === "win32" ? "junction" : "dir"

describe("FSUtil.canonical — the boundary is the FILE, not a spelling of it", () => {
  test("🔴 a target under a directory link that leaves the root is seen leaving it", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "project")
    const outside = path.join(tmp.path, "outside")
    await fs.mkdir(root, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, path.join(root, "escape"), DIR_LINK)

    // An EXISTING file below the link — the read/rename/trash shape.
    await fs.writeFile(path.join(outside, "valuable.txt"), "secret", "utf8")
    const existing = path.join(root, "escape", "valuable.txt")

    // This is the defect, stated as an assertion: the lexical check says the path is contained.
    expect(
      FSUtil.contains(root, path.resolve(root, "escape/valuable.txt")),
      "the premise of this test is gone — `contains` no longer accepts the escaping spelling",
    ).toBe(true)
    expect(FSUtil.containsCanonical(root, existing)).toBe(false)

    // A path that does NOT exist yet below the same link — the write/mkdir shape, and the one
    // `FSUtil.resolve` cannot answer because its ENOENT arm falls back to the lexical string.
    const prospective = path.join(root, "escape", "does-not-exist-yet.json")
    expect(FSUtil.containsCanonical(root, prospective)).toBe(false)

    // …and several levels below it, so the ancestor walk is exercised rather than one `dirname`.
    const deep = path.join(root, "escape", "a", "b", "c.json")
    expect(FSUtil.containsCanonical(root, deep)).toBe(false)
  })

  /**
   * ⚠️ **The negative half, and it is the half that decides whether this is a boundary or a wall.**
   * A guard that refuses everything satisfies every assertion above. Ordinary paths, prospective
   * ordinary paths, and a link that canonicalizes back INSIDE the root must all still be accepted.
   */
  test("ordinary paths, prospective paths and an internal link are still contained", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "project")
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "index.ts"), "export {}", "utf8")

    expect(FSUtil.containsCanonical(root, path.join(root, "src", "index.ts"))).toBe(true)
    expect(FSUtil.containsCanonical(root, path.join(root, "src", "new-file.ts"))).toBe(true)
    expect(FSUtil.containsCanonical(root, path.join(root, "brand", "new", "tree", "f.json"))).toBe(true)
    expect(FSUtil.containsCanonical(root, root)).toBe(true)

    // A link that points back inside the root is a legitimate project layout, not an escape.
    await fs.symlink(path.join(root, "src"), path.join(root, "alias"), DIR_LINK)
    expect(FSUtil.containsCanonical(root, path.join(root, "alias", "index.ts"))).toBe(true)
    expect(FSUtil.containsCanonical(root, path.join(root, "alias", "not-there-yet.ts"))).toBe(true)
  })

  /**
   * ⚠️ **Both sides canonicalize.** A root that is itself reached through a link — `/tmp` that is
   * really `/private/tmp`, a junctioned project folder — would reject every path under it if only
   * the child were canonicalized. This is the failure mode a one-sided fix ships.
   */
  test("a root reached through a link still contains its own files", async () => {
    await using tmp = await tmpdir()
    const real = path.join(tmp.path, "real-project")
    await fs.mkdir(path.join(real, "src"), { recursive: true })
    await fs.writeFile(path.join(real, "src", "index.ts"), "export {}", "utf8")
    const aliased = path.join(tmp.path, "aliased-project")
    await fs.symlink(real, aliased, DIR_LINK)

    expect(FSUtil.containsCanonical(aliased, path.join(aliased, "src", "index.ts"))).toBe(true)
    expect(FSUtil.containsCanonical(aliased, path.join(aliased, "src", "new.ts"))).toBe(true)
    // And it still refuses a genuine sibling.
    expect(FSUtil.containsCanonical(aliased, path.join(tmp.path, "elsewhere.txt"))).toBe(false)
  })

  test("a `..` escape is refused, with and without an existing target", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "project")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(tmp.path, "sibling.txt"), "x", "utf8")

    expect(FSUtil.containsCanonical(root, path.resolve(root, "../sibling.txt"))).toBe(false)
    expect(FSUtil.containsCanonical(root, path.resolve(root, "../not-there.txt"))).toBe(false)
  })

  test("canonical() of a path whose ancestor is a FILE walks past it rather than throwing", async () => {
    // ENOTDIR, not ENOENT — a distinct errno the ancestor walk has to accept, and one a client can
    // produce by writing `notes.txt/child.json`.
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "project")
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "notes.txt"), "x", "utf8")

    expect(() => FSUtil.canonical(path.join(root, "notes.txt", "child.json"))).not.toThrow()
    expect(FSUtil.containsCanonical(root, path.join(root, "notes.txt", "child.json"))).toBe(true)
  })
})
