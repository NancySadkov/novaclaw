export * as QualityDetect from "./quality-detect"

import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Shell } from "../../shell"
import { QualityProvision } from "./quality-provision"

/**
 * **Rung 0 against a real directory: read the manifests, run the scan.**
 *
 * 🔴 This is the ONE loader, and it exists because there were about to be two. `tool/quality-provision.ts`
 * had this block inline, and Settings → Quality needed the same answer for its "Detect from this
 * project" button — a second copy would have drifted the moment either side gained a manifest, in
 * the way the tool's own header warns about at length. The tool and the route now call this.
 *
 * ⚠️ `quality-provision.ts` itself stays PURE and injectable, deliberately: its whole detection
 * matrix is unit-tested with synthetic file lists and no filesystem at all. The impurity is here,
 * where it is a dozen lines of readdir and readFile, rather than pushed into the table it would
 * make untestable.
 *
 * ⚠️ This does NOT verify (rung 1) and does NOT write. Verification spawns a process per candidate;
 * a settings button that filled five boxes should not run five commands on the user's machine
 * uninvited, and the user reviewing the boxes IS the verification at that surface.
 */
export const detect = (directory: string): Effect.Effect<QualityProvision.Proposal> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise(() => fs.readdir(directory)).pipe(
      Effect.catch(() => Effect.succeed([] as string[])),
    )
    const contents = new Map<string, string | undefined>()
    for (const manifest of QualityProvision.MANIFEST_READS.filter((name) => entries.includes(name)))
      contents.set(
        manifest,
        yield* Effect.tryPromise(() => fs.readFile(path.join(directory, manifest), "utf8")).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      )
    return QualityProvision.scan({
      files: entries,
      read: (file) => contents.get(file),
      // The family of the shell these commands will actually run in — Git Bash on Windows whenever
      // one is found, cmd.exe only as the documented fallback. It decides `./gradlew` vs
      // `gradlew.bat`; guessing from `process.platform` would get the common Windows case backwards.
      shell: Shell.agentShellIsPosix() ? "posix" : "cmd",
    })
  })
