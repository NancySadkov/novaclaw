/** What a tab does when its shell ends.
 *
 * The rule, and it is a product judgement rather than a detail:
 *
 *   · exit 0 — the user typed `exit`, or the shell finished cleanly. CLOSE the tab. Every terminal
 *     people already use behaves this way, and leaving a corpse behind after a deliberate exit is
 *     noise that trains them to ignore the panel that matters.
 *   · anything else — KEEP the tab, marked exited, with the code shown. The output explaining WHY it
 *     died is in that tab's buffer, and deleting the tab deletes the explanation at exactly the moment
 *     it becomes the only thing the user wants. That is the dead-end AGENTS.md forbids ("it degrades
 *     and recovers... never a stack trace or a white screen"), and terminal.md T2 asks for the exited
 *     state and its exit code by name.
 *
 * Before this, every exit removed the tab and the code was dropped on the floor unread.
 */
export function shouldKeepExitedTab(exitCode?: number): boolean {
  return exitCode !== undefined && exitCode !== 0
}
