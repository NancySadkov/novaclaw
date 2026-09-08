import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { NpmConfig } from "@novaclaw/core/npm-config"
import { tmpdir } from "./fixture/tmpdir"

describe("NpmConfig.load", () => {
  test("reads registry from project .npmrc", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config.registry).toBe("https://registry.example.test/")
  })

  test("reads scoped registries from project .npmrc", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "@acme:registry=https://npm.acme.test/\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config["@acme:registry"]).toBe("https://npm.acme.test/")
  })

  test("flattens boolean and list options", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "ignore-scripts=true\nomit[]=dev\nomit[]=optional\n")

    const config = await Effect.runPromise(NpmConfig.load(tmp.path))

    expect(config.ignoreScripts).toBe(true)
    expect(config.omit).toEqual(["dev", "optional"])
  })
})

describe("NpmConfig.registry", () => {
  test("normalizes configured registry without trailing slash", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
  })

  test("leaves configured registry without trailing slash unchanged", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test\n")

    await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
  })
})

describe("NpmConfig does not rewrite this process's environment", () => {
  /**
   * 🔴 `@npmcli/config`'s `buildOmitList` ends with, literally:
   * `if (obj.omit.includes('dev')) { process.env.NODE_ENV = 'production' }`.
   *
   * So READING npm config flips the whole process to production. Two 🔴 guards key on
   * `NODE_ENV === "test"` — `crash-capture.ts` refusing to install real crash handlers, and
   * `db-path.ts` refusing to open the real instance database — and both switched off for the rest of
   * any process that had read npm config. It presented as an ordering-dependent gate flake.
   *
   * ⚠️ **Each test PINS `NODE_ENV` itself instead of capturing whatever it finds.** The first version
   * of these tests read `const before = process.env.NODE_ENV` and compared against it — and passed
   * with the guard deliberately removed, because the tests ABOVE in this same file had already
   * flipped the process to production. `before` was already `"production"`, so the assertion compared
   * production to production. A test for a process-wide mutation cannot trust the process state it
   * inherits.
   *
   * ⚠️ The `.npmrc` must ARM the bug. Measured: `production=true`, `omit=dev` and `only=prod` each
   * trigger the mutation; a plain `registry=` line does not. A fixture that does not provoke the
   * defect makes every assertion below vacuous.
   */
  const armed = ["production=true", "registry=https://registry.example.test/", ""].join("\n")

  /** Run `body` with NODE_ENV pinned to `pin`, and put the real value back afterwards. */
  const withNodeEnv = async (pin: string | undefined, body: () => Promise<void>) => {
    const had = Object.hasOwn(process.env, "NODE_ENV")
    const original = process.env["NODE_ENV"]
    if (pin === undefined) delete process.env["NODE_ENV"]
    else process.env["NODE_ENV"] = pin
    try {
      await body()
    } finally {
      if (had) process.env["NODE_ENV"] = original as string
      else delete process.env["NODE_ENV"]
    }
  }

  test("NODE_ENV survives a config read that would otherwise set it to production", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), armed)
    await withNodeEnv("test", async () => {
      await Effect.runPromise(NpmConfig.load(tmp.path))
      expect(process.env["NODE_ENV"]).toBe("test")
    })
  })

  test("registry() is guarded too — it is the caller that actually runs in the product", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), armed)
    await withNodeEnv("test", async () => {
      expect(await Effect.runPromise(NpmConfig.registry(tmp.path))).toBe("https://registry.example.test")
      expect(process.env["NODE_ENV"]).toBe("test")
    })
  })

  test("a value that is NOT 'test' is preserved as itself, not normalised", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), armed)
    await withNodeEnv("staging", async () => {
      await Effect.runPromise(NpmConfig.load(tmp.path))
      expect(process.env["NODE_ENV"]).toBe("staging")
    })
  })

  test("CONCURRENT reads do not corrupt the restore", async () => {
    // ⚠️ **This does NOT distinguish the re-entrant guard from a plain capture-and-restore** —
    // measured, it passes against both. The interleaving it is aimed at (an inner call capturing
    // while an outer is mid-mutation) is not reachable today: `config.flat` mutates and the `finally`
    // restores with no await between them. It is kept as a regression test for a future shape where
    // a mutation straddles an await, and is labelled so nobody reads it as proof of the branch.
    await using a = await tmpdir()
    await using b = await tmpdir()
    await Bun.write(path.join(a.path, ".npmrc"), armed)
    await Bun.write(path.join(b.path, ".npmrc"), armed)
    await withNodeEnv("test", async () => {
      await Promise.all([
        Effect.runPromise(NpmConfig.load(a.path)),
        Effect.runPromise(NpmConfig.load(b.path)),
        Effect.runPromise(NpmConfig.load(a.path)),
      ])
      expect(process.env["NODE_ENV"]).toBe("test")
    })
  })

  test("an ABSENT NODE_ENV stays absent, rather than coming back as the string 'undefined'", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".npmrc"), armed)
    await withNodeEnv(undefined, async () => {
      await Effect.runPromise(NpmConfig.load(tmp.path))
      expect(Object.hasOwn(process.env, "NODE_ENV")).toBe(false)
    })
  })
})
