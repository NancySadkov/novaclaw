import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Repository } from "@novaclaw/core/repository"

describe("Repository", () => {
  test("parses an explicit host path and builds an explicit-root cache path", () => {
    const reference = Repository.parseRemote("git.example.test/owner/repo")

    expect(reference).toMatchObject({
      host: "git.example.test",
      path: "owner/repo",
      segments: ["owner", "repo"],
      owner: "owner",
      repo: "repo",
      remote: "https://git.example.test/owner/repo.git",
      label: "git.example.test/owner/repo",
    })
    expect(Repository.cachePath("/cache", reference)).toBe(path.join("/cache", "git.example.test", "owner", "repo"))
    expect(Repository.cacheIdentity(reference)).toBe("git.example.test/owner/repo")
  })

  test("parses host path and scp remote references", () => {
    expect(Repository.parseRemote("gitlab.com/group/repo")).toMatchObject({
      host: "gitlab.com",
      path: "group/repo",
      remote: "https://gitlab.com/group/repo.git",
      label: "gitlab.com/group/repo",
    })
    expect(Repository.parseRemote("git@git.example.test:owner/repo.git")).toMatchObject({
      host: "git.example.test",
      path: "owner/repo",
      remote: "git@git.example.test:owner/repo.git",
      label: "git.example.test/owner/repo",
    })
  })

  test("keeps local file repositories distinct from remote repositories", () => {
    const localPath = path.resolve("repo.git")
    const reference = Repository.parse(pathToFileURL(localPath).href)

    expect(reference).toMatchObject({ host: "file", protocol: "file:", label: localPath })
    expect(reference && Repository.isFile(reference)).toBe(true)
    expect(reference && Repository.isRemote(reference)).toBe(false)
    expect(() => Repository.parseRemote(pathToFileURL(localPath).href)).toThrow(
      Repository.UnsupportedLocalRepositoryError,
    )
  })

  test("rejects unsafe remote references and branches with typed errors", () => {
    expect(() => Repository.parseRemote("not-a-repo")).toThrow(Repository.InvalidReferenceError)
    expect(() => Repository.parseRemote("git@git.example.test:../../../etc/passwd")).toThrow(
      Repository.InvalidReferenceError,
    )
    expect(() => Repository.validateBranch("feature/docs.v1")).not.toThrow()
    expect(() => Repository.validateBranch("-bad")).toThrow(Repository.InvalidBranchError)
    expect(() => Repository.validateBranch("bad..branch")).toThrow(Repository.InvalidBranchError)
    expect(() => Repository.validateBranch("bad branch")).toThrow(Repository.InvalidBranchError)
  })

  test("compares cache identity independent of input spelling", () => {
    const hostPath = Repository.parseRemote("git.example.test/owner/repo")

    expect(Repository.same(hostPath, Repository.parseRemote("https://git.example.test/owner/repo.git"))).toBe(true)
    expect(Repository.same(hostPath, Repository.parseRemote("git@git.example.test:owner/repo.git"))).toBe(true)
  })
})
