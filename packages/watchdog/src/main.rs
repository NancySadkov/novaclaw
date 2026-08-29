//! NovaClaw's watchdog — the process that outlives the instance.
//!
//! # Why this exists
//!
//! Measured 2026-08-29: a serve carrying three image-heavy sessions missed three health checks, its
//! in-process supervisor terminated and restarted it in one second, and the new child recovered all
//! three session ROWS — while none of the three drains resumed. The work was lost silently, and the
//! client waiting on it could not tell "still working" from "recovered and abandoned".
//!
//! The in-process supervisor (`cli/cmd/serve.ts`) handles the case it can see: a child that stops
//! answering its health probe. **It cannot handle its own death.** If the supervising process is
//! killed, wedged, or taken down with the machine, nothing restarts anything. That is this binary's
//! job, and it is the whole reason it is a separate, tiny, dependency-free program.
//!
//! ⭐ **Rust rather than C99** (owner offered either, "whichever is smaller / easier to implement
//! without bugs"). Process supervision in C means two implementations — `CreateProcess`/
//! `WaitForSingleObject` and `fork`/`execv`/`waitpid` — and the bugs in a watchdog live exactly
//! there: handle leaks, unreaped zombies, signal races. `std::process` is one cross-platform source
//! file with no unsafe and no manual handle management, in a program whose entire value proposition
//! is never crashing.
//!
//! # 🔴 The protocol: telling a LEGITIMATE exit from a CRASH
//!
//! An exit code alone cannot express *"restart me in one hour"*, and an intent file alone can be
//! stale or half-written. So the watchdog requires **two independent signals that agree**, which is
//! the same rule the research skill states for any gate worth having: a shortcut must not be able to
//! satisfy both at once.
//!
//! 1. **The exit STATUS must be the agreed clean code** ([`INTENT_EXIT_CODE`]).
//! 2. **An intent FILE must exist and parse.**
//!
//! Either one alone is treated as a crash, and that asymmetry is deliberate — see *Failing safe*.
//!
//! The child writes the file immediately before exiting, atomically (write `<path>.tmp`, then
//! rename — rename is atomic on both platforms), and the watchdog **deletes it the moment it is
//! read**, and again **before every spawn**. It is single-use by construction, so an intent can
//! never be replayed onto a later run.
//!
//! ## Failing safe, and which direction that is
//!
//! ⚠️ Every ambiguous case is treated as a **crash**, i.e. as *restart*. The two errors are not
//! symmetric: restarting an instance that meant to stay down costs one unwanted start, which the
//! operator can see and stop. Failing to restart one that crashed loses the work silently — the
//! failure this file exists to prevent. So a missing file, a truncated file, unparseable contents, a
//! non-clean exit code, or a kill by signal all mean *restart*.
//!
//! # Dormancy
//!
//! An instance may exit deliberately and name when it must come back:
//!
//! ```json
//! {"kind":"dormant","wakeAtMs":1787961234567}
//! ```
//!
//! ⚠️ `wakeAtMs` is an ABSOLUTE wall-clock instant, not a duration, and that is the right choice for
//! the user-facing meaning of dormancy: *"be back at nine"* survives the watchdog being restarted or
//! the machine sleeping, where a duration would restart its own countdown. A wake time already in
//! the past means *start now* — the safe direction again, and what a clock jump or a long suspend
//! should produce.

//! # ⚠️ The command must be a REAL executable, not a shim
//!
//! Measured while writing the live smoke: `Command::new("bun")` fails with *program not found* on
//! Windows even though `bun` is on PATH, because it resolves there as `bun.ps1`/`bun.cmd` — an npm
//! shim — and Rust's PATH search appends `.exe` only.
//!
//! 🔴 **This is deliberately NOT worked around by shelling through `cmd /c`.** That would make every
//! supervised command a string parsed by a shell, which is a quoting hazard and an injection surface
//! in the one process that must never misbehave. The watchdog spawns exactly what it is given.
//!
//! So the caller passes an ABSOLUTE path to a real binary — which is what a packaged install has
//! anyway. A command that cannot be found is reported and retried on the ladder rather than being
//! fatal: it may be a half-finished autoupdate, and an instance that gives up because its binary was
//! momentarily absent is the failure this program exists to prevent.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The exit status a child must use to have its intent honoured.
///
/// ⚠️ **Zero would be wrong.** An ordinary clean exit — an operator's Ctrl-C handled gracefully, a
/// library calling `exit(0)`, a shell wrapper returning its own success — is also 0, so 0 cannot
/// distinguish *"I am exiting on purpose AND I have left you instructions"* from *"something ended
/// tidily"*. A reserved, unlikely code makes the signal deliberate.
const INTENT_EXIT_CODE: i32 = 77;

/// Restart delay ladder after a crash, in milliseconds.
///
/// ⚠️ The last entry is the ceiling and it REPEATS — the watchdog never gives up permanently, which
/// is the opposite of the in-process supervisor's `giveup`. That one can afford to stop because a
/// human is usually present at a terminal; this one exists precisely for the unattended case, and an
/// instance that stays down forever because of a transient boot failure is the outcome it is here to
/// prevent. Capping the *rate* bounds the damage instead.
const BACKOFF_MS: [u64; 6] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/// How long a child must stay alive for its start to count as SUCCESSFUL, resetting the ladder.
///
/// 🔴 Without this the ladder is decorative: a child that dies after ten minutes, twice a day, would
/// climb to the 30 s cap and stay there, while a child crash-looping in 50 ms would be indexed the
/// same way. What matters is whether the last start achieved anything.
const HEALTHY_AFTER_MS: u128 = 60_000;

/// How often the dormant sleep wakes to re-check.
///
/// ⚠️ A poll rather than a timed condvar or a signal handler, deliberately. The wake needs to be
/// interruptible (an operator may launch the instance by hand, or ask for an early wake), and doing
/// that with signals means one implementation per platform plus the async-signal-safety rules — the
/// exact class of bug this binary must not have. One second of latency on an hour-long dormancy is
/// free; a signal-handling race in a watchdog is not.
const DORMANCY_TICK: Duration = Duration::from_secs(1);

#[derive(Debug, PartialEq)]
enum Intent {
    /// Stay down. The watchdog exits with the child.
    Shutdown,
    /// Come back at this absolute wall-clock instant (ms since the Unix epoch).
    Dormant { wake_at_ms: u128 },
    /// Come back immediately — an autoupdate or an operator-requested bounce.
    Restart,
}

/// What the watchdog decided to do about an exit, and why. Returned as a value rather than acted on
/// inline so the classification is a pure function of (status, intent) and can be tested as one.
#[derive(Debug, PartialEq)]
enum Decision {
    Stop,
    RestartNow,
    RestartAt { wake_at_ms: u128 },
    /// The exit was not legitimate. Restart after the ladder's delay for this attempt.
    RestartAfterCrash,
}

/// 🔴 THE CLASSIFIER — the whole "legitimate exit vs crash" question, as one pure function.
///
/// `code` is `None` when the child was killed by a signal or the status could not be read, which is
/// unambiguously a crash: a process that was shot did not choose to leave.
fn classify(code: Option<i32>, intent: Option<Intent>) -> Decision {
    // BOTH signals, or neither counts. An intent without the clean code is the "crashed after
    // writing its plans" case; a clean code without an intent is a child that exited tidily but said
    // nothing, and saying nothing is not the same as asking to stay down.
    match (code, intent) {
        (Some(INTENT_EXIT_CODE), Some(Intent::Shutdown)) => Decision::Stop,
        (Some(INTENT_EXIT_CODE), Some(Intent::Restart)) => Decision::RestartNow,
        (Some(INTENT_EXIT_CODE), Some(Intent::Dormant { wake_at_ms })) => Decision::RestartAt { wake_at_ms },
        _ => Decision::RestartAfterCrash,
    }
}

/// Parse an intent document. Hand-rolled rather than pulling in a JSON crate: the grammar is three
/// keys, and a dependency-free watchdog is worth more than a general parser.
///
/// ⚠️ Anything unrecognised returns `None`, which the classifier reads as a crash — the safe
/// direction. A truncated write, a half-flushed buffer and a file from a future version of NovaClaw
/// all land here, and all of them should produce a restart rather than a guess.
fn parse_intent(text: &str) -> Option<Intent> {
    let kind = json_string(text, "kind")?;
    match kind.as_str() {
        "shutdown" => Some(Intent::Shutdown),
        "restart" => Some(Intent::Restart),
        "dormant" => {
            // ⚠️ A dormant intent WITHOUT a wake time is not a dormant intent. Defaulting it to
            // "now" would be inventing a policy the writer did not state, and defaulting it to
            // "never" would strand the instance — so it is malformed, and malformed means restart.
            let wake_at_ms = json_number(text, "wakeAtMs")?;
            Some(Intent::Dormant { wake_at_ms })
        }
        _ => None,
    }
}

/// The value of `"<key>": "<string>"`, or `None`.
fn json_string(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let after = &text[text.find(&needle)? + needle.len()..];
    let after = after.trim_start().strip_prefix(':')?.trim_start();
    let rest = after.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// The value of `"<key>": <number>`, or `None`. Rejects anything that is not a plain integer.
fn json_number(text: &str, key: &str) -> Option<u128> {
    let needle = format!("\"{key}\"");
    let after = &text[text.find(&needle)? + needle.len()..];
    let after = after.trim_start().strip_prefix(':')?.trim_start();
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

/// Read and CONSUME the intent file. Deleting on read is what makes an intent single-use, so a file
/// left behind by a crash cannot be honoured by a later exit.
fn take_intent(path: &Path) -> Option<Intent> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        // An unreadable file is not an intent. Restart.
        Err(_) => {
            let _ = fs::remove_file(path);
            return None;
        }
    };
    let _ = fs::remove_file(path);
    parse_intent(&text)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// Sleep until `wake_at_ms`, in short ticks, so the wait stays interruptible and a clock that jumps
/// backwards cannot park the instance for years.
fn sleep_until(wake_at_ms: u128, wake_now: &Path) {
    loop {
        let now = now_ms();
        if now >= wake_at_ms {
            return;
        }
        // An operator (or the desktop app) can end dormancy early by creating this file. A file
        // rather than a signal, for the reason on DORMANCY_TICK.
        if wake_now.exists() {
            let _ = fs::remove_file(wake_now);
            return;
        }
        let remaining = wake_at_ms - now;
        std::thread::sleep(if remaining < DORMANCY_TICK.as_millis() {
            Duration::from_millis(remaining as u64)
        } else {
            DORMANCY_TICK
        });
    }
}

struct Args {
    state_dir: PathBuf,
    command: Vec<String>,
}

/// `novaclaw-watchdog --state <dir> -- <command> [args…]`
fn parse_args() -> Result<Args, String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut state_dir: Option<PathBuf> = None;
    let mut index = 0;
    while index < argv.len() {
        match argv[index].as_str() {
            "--state" => {
                state_dir = Some(PathBuf::from(argv.get(index + 1).ok_or("--state needs a directory")?));
                index += 2;
            }
            "--" => {
                let command: Vec<String> = argv[index + 1..].to_vec();
                if command.is_empty() {
                    return Err("no command after --".into());
                }
                return Ok(Args { state_dir: state_dir.ok_or("--state is required")?, command });
            }
            other => return Err(format!("unexpected argument {other}")),
        }
    }
    Err("expected: --state <dir> -- <command> [args…]".into())
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("[watchdog] {message}");
            return ExitCode::from(2);
        }
    };
    if let Err(error) = fs::create_dir_all(&args.state_dir) {
        eprintln!("[watchdog] cannot create state dir: {error}");
        return ExitCode::from(2);
    }
    let intent_path = args.state_dir.join("exit-intent.json");
    let wake_now = args.state_dir.join("wake-now");

    let mut attempt = 0usize;
    loop {
        // 🔴 Clear BEFORE spawning. Together with consuming on read this is what makes an intent
        // single-use: a file that survived a hard kill cannot speak for the run about to start.
        let _ = fs::remove_file(&intent_path);

        let started = now_ms();
        // 🔴 TELL THE CHILD IT IS SUPERVISED, and how to reach us.
        //
        // Without this the child cannot know whether anything is listening, and the only safe thing
        // it could do is behave as though nothing were — which is exactly right when nothing is. The
        // variable is set by this program and by nothing else, so its presence is a complete answer
        // and an unsupervised run's exit statuses stay byte-identical to what they always were.
        let mut child = match Command::new(&args.command[0])
            .args(&args.command[1..])
            .env("NOVACLAW_WATCHDOG_STATE", &args.state_dir)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                // A command that cannot even start is a crash like any other — it may be a
                // half-finished autoupdate, so it is retried on the ladder rather than fatal.
                eprintln!("[watchdog] cannot start {}: {error}", args.command[0]);
                let delay = BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)];
                attempt += 1;
                std::thread::sleep(Duration::from_millis(delay));
                continue;
            }
        };
        eprintln!("[watchdog] started pid {}", child.id());

        let status = match child.wait() {
            Ok(status) => status,
            Err(error) => {
                eprintln!("[watchdog] cannot wait on child: {error}");
                return ExitCode::from(2);
            }
        };
        let alive_ms = now_ms().saturating_sub(started);
        let decision = classify(status.code(), take_intent(&intent_path));

        // A start that lasted counts as successful, whatever ended it — see HEALTHY_AFTER_MS.
        if alive_ms >= HEALTHY_AFTER_MS {
            attempt = 0;
        }

        match decision {
            Decision::Stop => {
                eprintln!("[watchdog] child asked to stay down — exiting");
                return ExitCode::SUCCESS;
            }
            Decision::RestartNow => {
                eprintln!("[watchdog] child asked for a restart");
                attempt = 0;
            }
            Decision::RestartAt { wake_at_ms } => {
                let now = now_ms();
                let seconds = wake_at_ms.saturating_sub(now) / 1000;
                eprintln!("[watchdog] child went dormant — waking in {seconds}s");
                sleep_until(wake_at_ms, &wake_now);
                attempt = 0;
            }
            Decision::RestartAfterCrash => {
                let delay = BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)];
                eprintln!(
                    "[watchdog] child exited {:?} after {alive_ms}ms without a valid intent — restarting in {delay}ms",
                    status.code()
                );
                attempt += 1;
                std::thread::sleep(Duration::from_millis(delay));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 🔴 THE TWO-SIGNAL RULE. Each half alone must read as a crash, or the gate is one signal with
    // extra steps.
    #[test]
    fn intent_without_the_clean_code_is_a_crash() {
        assert_eq!(classify(Some(0), Some(Intent::Shutdown)), Decision::RestartAfterCrash);
        assert_eq!(classify(Some(1), Some(Intent::Shutdown)), Decision::RestartAfterCrash);
        assert_eq!(
            classify(Some(1), Some(Intent::Dormant { wake_at_ms: 42 })),
            Decision::RestartAfterCrash
        );
    }

    #[test]
    fn the_clean_code_without_an_intent_is_a_crash() {
        assert_eq!(classify(Some(INTENT_EXIT_CODE), None), Decision::RestartAfterCrash);
    }

    #[test]
    fn a_signal_kill_is_a_crash_even_with_an_intent() {
        assert_eq!(classify(None, Some(Intent::Shutdown)), Decision::RestartAfterCrash);
    }

    #[test]
    fn both_signals_agreeing_is_honoured() {
        assert_eq!(classify(Some(INTENT_EXIT_CODE), Some(Intent::Shutdown)), Decision::Stop);
        assert_eq!(classify(Some(INTENT_EXIT_CODE), Some(Intent::Restart)), Decision::RestartNow);
        assert_eq!(
            classify(Some(INTENT_EXIT_CODE), Some(Intent::Dormant { wake_at_ms: 99 })),
            Decision::RestartAt { wake_at_ms: 99 }
        );
    }

    // ⚠️ An ordinary clean exit must NOT be able to stop the watchdog, which is why the agreed code
    // is not 0.
    #[test]
    fn exit_zero_is_not_a_shutdown_request() {
        assert_eq!(classify(Some(0), None), Decision::RestartAfterCrash);
    }

    #[test]
    fn parses_the_three_kinds() {
        assert_eq!(parse_intent(r#"{"kind":"shutdown"}"#), Some(Intent::Shutdown));
        assert_eq!(parse_intent(r#"{"kind":"restart"}"#), Some(Intent::Restart));
        assert_eq!(
            parse_intent(r#"{"kind":"dormant","wakeAtMs":1787961234567}"#),
            Some(Intent::Dormant { wake_at_ms: 1787961234567 })
        );
    }

    #[test]
    fn tolerates_whitespace_and_key_order() {
        assert_eq!(
            parse_intent("{ \"wakeAtMs\" : 5 , \"kind\" : \"dormant\" }"),
            Some(Intent::Dormant { wake_at_ms: 5 })
        );
    }

    // 🔴 EVERY malformed shape is a crash, i.e. a restart. This is the failing-safe direction: an
    // unwanted start is visible and stoppable, a silent failure to restart is what loses the work.
    #[test]
    fn malformed_documents_are_not_intents() {
        assert_eq!(parse_intent(""), None);
        assert_eq!(parse_intent("{"), None);
        assert_eq!(parse_intent(r#"{"kind":"dorm"#), None, "a truncated write");
        assert_eq!(parse_intent(r#"{"kind":"hibernate"}"#), None, "a kind from a future version");
        assert_eq!(parse_intent(r#"{"kind":"dormant"}"#), None, "dormant with no wake time");
        assert_eq!(parse_intent(r#"{"kind":"dormant","wakeAtMs":"soon"}"#), None);
        assert_eq!(parse_intent(r#"{"kind":"dormant","wakeAtMs":-5}"#), None, "a negative instant");
    }

    // ⚠️ The ladder must CAP rather than run off the end of the array, and it must never stop
    // restarting — the unattended case is the one this binary exists for.
    #[test]
    fn the_backoff_ladder_caps_and_never_gives_up() {
        for attempt in 0..100usize {
            let delay = BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)];
            assert!(delay <= 30_000);
        }
        assert_eq!(BACKOFF_MS[99usize.min(BACKOFF_MS.len() - 1)], 30_000);
    }
}
