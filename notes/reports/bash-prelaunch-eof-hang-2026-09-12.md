# Bash prelaunch EOF hang — 2026-09-12

## Incident

The live packaged instance under `C:\Users\nangl\Downloads\2\nova-new` left Daedalus's bash tool call
running indefinitely while preparing a 3D render in `C:\Users\nangl\d\code\test\demoscene`.

The durable tool row was created at `2026-09-12T19:06:15.785+02` with a requested 600000 ms timeout,
but it never acquired a completion timestamp. There was no corresponding `bash_job` row and no bash,
renderer, or `comms.exe` descendant process. The session worker remained alive and consumed essentially
one full CPU core: its cumulative CPU time advanced from 1748.125 s to 1750.109375 s during a two-second
sample. The command therefore had not launched; command preflight had synchronously wedged the worker's
JavaScript event loop, which also prevented the in-process timeout timer and worker heartbeat timer from
running.

## Root cause

Minimal reproducer:

```sh
f=$(( i*NF/NC ))
```

`ShellApproval.words` skipped separators with this predicate:

```ts
";|&<>()".includes(command[index] ?? "")
```

At end of input, the fallback is the empty string, and every JavaScript string includes the empty string.
The scanner therefore incremented forever after trailing whitespace or a closing arithmetic-substitution
delimiter.

Bug class: a scanner substituted an empty string for EOF and passed it to a membership predicate that
accepts the empty string, making end-of-input indistinguishable from another skippable token.

A behavioral sweep for the `includes(value ?? "")` scanner shape found one instance in the source tree:
the faulty loop itself. Other `includes` calls did not combine an empty EOF sentinel with an unbounded
scanner loop.

The source-level cause was an API spelling where the unsafe EOF fallback was shorter than an explicit
input bound. The loop now tests `index < command.length` before either membership predicate, making EOF
unrepresentable as a token. A regression drives the shortened live command through the parser and asserts
bounded completion.

## Harness closure

The parser fix removes this incident. Three independent containment layers close the broader class:

1. The central tool registry rejects an explicit timeout above the effective officer ceiling before a
   tool runs. The shipped ceiling is 600000 ms and an officer can override it in human minutes; the
   parent-chain config fold carries it into spawned workers.
2. Every tool invocation has a registry-owned asynchronous wall deadline. Bash additionally handshakes
   actual OS process creation, so spawn failure returns immediately with its operating-system cause, and
   command preflight has a short 10-second launch guard.
3. The session supervisor enforces the same ceiling outside the worker process from heartbeat silence.
   It also watches a dispatched bash call for 10 seconds without a fresh heartbeat. This outer process is
   the layer that can terminate a synchronously wedged event loop; no timer inside that loop can do so.
   The supervisor tree-kills the worker and its descendants, records a specific failure, and starts the
   existing fenced recovery path without replaying an uncertain side effect.

The command-launch detector requires both the dispatch timestamp and the newest heartbeat to be stale.
This lets a healthy long-running command continue indefinitely as a durable bash job while catching a
preflight loop even if one heartbeat races between the durable dispatch acknowledgement and the faulty
parser.

## Verification

- `packages/core/test/shell-approval.test.ts`: the spaced arithmetic substitution terminates in under
  the test's 100 ms bound.
- `packages/core/test/bash-jobs-durable.test.ts`: a mocked OS `ENOENT` returns as `JobLaunchError`, with
  the cause, in about 40 ms.
- `packages/core/test/tool-registry.test.ts`: 600001 ms is refused before execution; an asynchronous tool
  is interrupted at its declared deadline and returns an explanatory error.
- `packages/novaclaw/src/session-worker/supervisor.test.ts`: a CPU-bound worker and a Daedalus-shaped bash
  preflight wedge are tree-killed by the host; a healthy asynchronous wait and a healthy long bash call
  survive the same probes because they continue to heartbeat.
