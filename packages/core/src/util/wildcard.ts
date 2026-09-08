export * as Wildcard from "./wildcard"

// ⚠️ NOT A SECURITY BOUNDARY. Read this before using `match` to gate anything.
//
// This is a glob→regex matcher over a COMMAND STRING. When it gates `bash`, it is a
// prompt-reduction CONVENIENCE ("don't ask me again for `git status`") and nothing more. A text
// matcher cannot model shell expansion, so an injected command reaches the same place by any of
// `r''m`, `rm$IFS-rf`, `$(echo rm)`, `find / -delete`, or a base64 pipe — none of which this
// pattern-matches. GuardFall (2026) broke 10 of 11 open agents through exactly this class of
// control, and the industry reflex of hardening the blocklist does not fix it: the defect is
// structural, not a missing pattern.
//
// So: deny-patterns here are ADVISORY. Never treat a `match` result as containment, and never add a
// pattern with the intent of making something *safe* — that reasoning is how a convenience becomes
// load-bearing. Real confinement is the kernel below (a restricted FS view + deny-by-default
// network), which is the AgentJail program in todo.md; inside such a box we no longer care what the
// string decodes to, because the blast radius is the worktree and the only route out is the model
// provider. This comment exists so that lesson is baked into the code rather than kept in a doc.
export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}
