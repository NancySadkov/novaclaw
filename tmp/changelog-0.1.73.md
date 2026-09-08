# NovaClaw 0.1.73

- Improved long-context reliability: context capacity no longer shrinks recursively from ordinary requests, compaction preserves semantic history limits, and recovery is faster and more accurate.
- Made agent progress and delegation clearer across Contacts, chats, and wait rows, with stable status through view changes and useful worker labels that do not expose private prompts.
- Improved transcript feedback: file edits reveal their target path while tool input is still streaming, `exit(result)` is shown as the agent's final answer, and completed turns report `Done in <time>` without leaking internal step counts or rendering invalid durations.
- Restored Nova's bundled portrait, added consistent icons for transcript tools, and reset a colleague's job label when its chat is cleared.
- Added configurable, per-agent user nudges with durable scheduling and a complete Settings editor, while removing automatic prompts that inferred unfinished work from ambient file lists.
- Polished the interface: tabs no longer shift when selected, every dropdown now uses the themed picker, the Skills tile has the standard icon frame, and the home prompt now reads “Ask anything...”.
