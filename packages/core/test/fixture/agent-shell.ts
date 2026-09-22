import { existsSync } from "node:fs"
import path from "node:path"
import { Shell } from "@novaclaw/core/shell"

/**
 * **Point the tests at the ONE shell NovaClaw ships, instead of at whatever the host happens to have.**
 *
 * 🔴 The reason this file exists. NovaClaw ships `w64devkit` on Windows precisely so there is a
 * SINGLE agent shell and no second dialect to support (`shell.ts` → `agentDefault`). `test/preload.ts`
 * scrubs `NOVACLAW_W64DEVKIT_PATH` — correctly, because the launcher's value describes the running
 * product's install rather than the checkout under test (`fixture/launcher-env.ts`). The consequence
 * on a Windows source tree is that `agentDefault()` falls back to `cmd.exe`, and any test asserting
 * the shipped shell's behaviour then fails for a reason that has nothing to do with the code.
 *
 * ⚠️ **The wrong repair is to teach those tests what `cmd.exe` does.** That would encode the second
 * dialect into the suite — the exact support burden shipping the bundle exists to avoid — and it makes
 * a green run say "cmd.exe was handled", not "the shipped shell works". So the tests that assert the
 * shipped shell resolve it explicitly, here, and refuse to assert anything when it is not prepared.
 *
 * The artifact is `packages/desktop/resources/third-party/w64devkit`, a gitignored build product
 * (`packages/desktop/scripts/prepare-w64devkit.ts`). It is deliberately NOT set from `preload.ts`:
 * a process-wide value is what `launcher-env.ts` documents breaking four `shell.test.ts` cases with
 * (bundle-first resolution beats an explicitly-set `$SHELL`), so the binding is scoped to the files
 * that mean it and restored when they finish.
 */

/** `<repo>/packages/desktop/resources/third-party/w64devkit`, resolved from this file's own location. */
const KIT_ROOT = path.join(import.meta.dir, "..", "..", "..", "desktop", "resources", "third-party", "w64devkit")

/** The same two files `Shell.w64devkitRoot()` requires — a half-prepared tree is not a shell. */
const prepared = () =>
  existsSync(path.join(KIT_ROOT, "bin", "sh.exe")) && existsSync(path.join(KIT_ROOT, "bin", "gcc.exe"))

/**
 * Is the shipped shell available to assert against? True off Windows (the agent shell there is
 * `bash`/`sh`, already POSIX and already the one we support) and true on Windows only when this
 * checkout has run the w64devkit prepare step.
 */
export const shippedAgentShellAvailable = process.platform !== "win32" || prepared()

/**
 * Bind the process to the shipped shell and hand back the undo.
 *
 * Call at file scope and restore in `afterAll`: core's tests share a process, so an unbinding that
 * never runs would leave every later file answering about the bundle.
 */
export function useShippedAgentShell(): () => void {
  const saved = process.env.NOVACLAW_W64DEVKIT_PATH
  if (process.platform === "win32") process.env.NOVACLAW_W64DEVKIT_PATH = KIT_ROOT
  Shell.agentDefault.reset()
  return () => {
    if (saved === undefined) delete process.env.NOVACLAW_W64DEVKIT_PATH
    else process.env.NOVACLAW_W64DEVKIT_PATH = saved
    Shell.agentDefault.reset()
  }
}
