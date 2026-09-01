export * as ToolPolicyBuiltin from "./tool-policy-builtin"

import { Effect, Layer } from "effect"
import { ToolPolicy } from "./tool-policy"
import { ToolPolicyGate } from "./tool-policy-gate"
import { makeLocationNode } from "./effect/app-node"

/**
 * The pre-action policies NovaClaw ships with.
 *
 * ⚠️ **Kept small on purpose, and separate from the kernel.** `tool-policy.ts` must not learn a
 * tool's name or a command's shape — that is the same discipline `ToolRegistry` keeps ("the registry
 * must never learn a tool's name"). Everything domain-specific lives here, behind the same
 * `ToolPolicy.Provider` interface a plugin would implement, so the shipped policies are not a
 * privileged category.
 */

/**
 * The commands that are refused outright, and the ones that are held for a human.
 *
 * ⚠️ **This is prompt-reduction and blast-radius reduction, NOT containment**, and the distinction is
 * the one `permission.ts` draws above `evaluate`: matching a command STRING is best-effort by
 * construction — a variable, a subshell, a here-doc or a `find -exec` is invisible to it, exactly as
 * AGENTS.md design principle 13 already records for the exclusion list's `bash` scan. Hard
 * confinement is the operator's boundary (Agent Jail). What this buys is that the three or four commands that
 * cannot be undone stop being one hallucinated token away, which is worth having even though a
 * determined injection walks around it.
 *
 * Membership test, so this list does not grow into a lint: a command belongs under `REFUSE` only if
 * it is **irreversible and host-wide** — it destroys something outside the session's folder that no
 * later action can restore. Anything merely destructive *inside* the folder is ordinary agent work
 * and is governed by permissions, not by this.
 */
const REFUSE: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    // `rm -rf /`, `rm -rf /*`, and the `$HOME`-empty variant that ate a well-known installer.
    pattern: /\brm\s+(?:-[a-zA-Z]+\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(?:\/|\/\*|"?\$\{?HOME\}?"?\/?\*?|~\/?\*?)(?:\s|$)/,
    why: "it deletes the filesystem root or the whole home directory, which nothing can undo",
  },
  {
    pattern: /\bmkfs(\.[a-z0-9]+)?\b/,
    why: "it formats a filesystem",
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|disk|rdisk)/,
    why: "it writes raw bytes over a block device",
  },
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    why: "it is a fork bomb",
  },
]

/**
 * Commands a human should see before they run. Each is recoverable in principle and catastrophic in
 * practice, which is exactly the shape an approval is for — a refusal would be wrong (these are all
 * things a user legitimately asks for) and an allow would be wrong (they are all things a user
 * legitimately wants to be asked about).
 */
const APPROVE: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)|(?:^|\s)-f(?:\s|$))/,
    why: "a force push can discard commits on the remote that are not in this checkout",
  },
  {
    pattern: /\bgit\s+reset\s+(?:[^\n]*\s)?--hard\b/,
    why: "a hard reset discards uncommitted work with no way back",
  },
  {
    pattern: /\bgit\s+clean\b[^\n]*-[a-zA-Z]*[fd]/,
    why: "it deletes untracked files, which are not in any commit",
  },
  {
    pattern: /\bnpm\s+publish\b|\bbun\s+publish\b/,
    why: "publishing is public and a version can never be re-published",
  },
]

/** `sudo` is not refused and not held — it is NAMED, so the model knows what it just escalated to. */
const SUDO = /(?:^|\s|[;|&])sudo(?:\s|$)/

/** The tools whose input carries a shell command, and the field it lives in. */
const COMMAND_FIELD: Readonly<Record<string, string>> = { bash: "command" }

/**
 * ⛔ **The one shipped safety policy.** Always on: it is installed because the operator installed
 * NovaClaw, and a folder cannot switch it off — a `novaclaw.json` may only turn opt-in policies ON.
 */
export const irreversibleShell: ToolPolicy.Provider = {
  id: "irreversible-shell",
  describe: "Refuses host-wide irreversible shell commands, and asks before the recoverable-but-costly ones.",
  evaluate: (request) =>
    Effect.sync((): ToolPolicy.Outcome => {
      const field = COMMAND_FIELD[request.tool]
      if (field === undefined) return { type: "allow" }
      const command = request.input[field]
      if (typeof command !== "string" || command.trim().length === 0) return { type: "allow" }

      for (const entry of REFUSE)
        if (entry.pattern.test(command))
          return {
            type: "deny",
            reason: `the command was refused because ${entry.why}`,
          }

      for (const entry of APPROVE)
        if (entry.pattern.test(command))
          return {
            type: "approve",
            // A dedicated action, so a user's "always" answer is about THIS class of command and not
            // about `bash` in general — answering "always allow bash" must not silently also mean
            // "always force-push".
            action: "irreversible_shell",
            resources: [command],
            reason: `${entry.why} — approve it only if that is what you meant`,
          }

      if (SUDO.test(command))
        return {
          type: "context",
          text:
            "This command was run with `sudo`, so it acted with administrator rights on the user's machine. " +
            "Say so plainly in your reply, and do not use `sudo` again unless the task actually requires it.",
        }

      return { type: "allow" }
    }),
}

/**
 * Git's pager wedges a non-interactive shell.
 *
 * 🔴 **The one shipped PATCH, and it is a patch rather than a refusal because the model's intent is
 * right and only its spelling is wrong.** `git log`, `git diff`, `git show` and `git branch` page
 * through `less` when stdout looks like a terminal; in a shell with no reader on the other end that
 * is a process which never exits, and *a wedge looks exactly like work* is the single most expensive
 * trap recorded in this repo. Rewriting the command to `git --no-pager <cmd>` is what a person would
 * type, and the receipt says it happened — a silent rewrite is the thing this whole feature forbids.
 *
 * ⚠️ ADVISORY (`safetyCritical: false`): if this policy ever hangs or throws, a `git log` should
 * still run. Failing closed is for a policy whose absence is a hazard; the absence of this one costs
 * a wedge that the shell's own timeout already bounds.
 */
export const gitNoPager: ToolPolicy.Provider = {
  id: "git-no-pager",
  describe: "Rewrites paging git commands to `git --no-pager …`, which cannot wedge a non-interactive shell.",
  safetyCritical: false,
  evaluate: (request) =>
    Effect.sync((): ToolPolicy.Outcome => {
      const field = COMMAND_FIELD[request.tool]
      if (field === undefined) return { type: "allow" }
      const command = request.input[field]
      if (typeof command !== "string") return { type: "allow" }
      // Only a command that STARTS with `git <pager-subcommand>`. A `git log` inside a pipeline or
      // after a `&&` is left alone deliberately: rewriting a fragment of a compound command means
      // parsing a shell, and this policy does not parse a shell (see `irreversibleShell`'s note).
      const match = /^\s*git\s+(log|diff|show|branch|tag|blame|shortlog|reflog)\b/.exec(command)
      if (!match) return { type: "allow" }
      if (/^\s*git\s+(?:-c\s+\S+\s+)*--no-pager\b/.test(command)) return { type: "allow" }
      return {
        type: "patch",
        fields: { [field]: command.replace(/^(\s*)git\s+/, "$1git --no-pager ") },
        reason:
          `\`git ${match[1]}\` was rewritten to \`git --no-pager ${match[1]}\` before it ran. Without it git ` +
          `starts a pager that never exits in a shell with no reader, and the call would have hung rather ` +
          `than failed. The output below is the real output of your command.`,
      }
    }),
}

export const BUILTINS: readonly ToolPolicy.Provider[] = [gitNoPager, irreversibleShell]

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gate = yield* ToolPolicyGate.Service
    yield* gate.install(BUILTINS).pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool-policy/builtin", layer, deps: [ToolPolicyGate.node] })
