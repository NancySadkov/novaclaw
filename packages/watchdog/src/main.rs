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
//! fatal: it may be a half-finished binary replacement, and an instance that gives up because its binary was
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

/// The smallest gap between two starts, whatever asked for the second one.
///
/// 🔴 **The ladder above bounds the rate of CRASH restarts, and it used to be the only bound there
/// was — so the two arms that do not consult it had no rate limit at all.** A child that boots,
/// fails to apply a pending update, writes `{"kind":"restart"}` and exits 77 in 50 ms was respawned
/// with no delay, forever: a 20 Hz process-spawn loop in the one binary whose value proposition is
/// never misbehaving. A `dormant` whose `wakeAtMs` is already past (a clock jump, or a child
/// computing its wake time from a stale base) does the same through a `sleep_until` that returns
/// immediately.
///
/// ⚠️ So the floor is NOT a second check on those two paths. It is a precondition of the ONE place
/// a child is ever started, which is what makes it impossible to route around: a decision arm added
/// later gets it without knowing it exists, and so does the spawn-failure retry. `BACKOFF_MS[0]` is
/// deliberately the same number as the ladder's first rung — a legitimate restart is not slower than
/// a first crash restart, and it is not faster either.
const MIN_RESTART_GAP_MS: u64 = BACKOFF_MS[0];

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
    /// Come back immediately — a binary replacement or an operator-requested bounce.
    Restart,
}

/// What the watchdog decided to do about an exit, and why. Returned as a value rather than acted on
/// inline so the classification is a pure function of (status, intent) and can be tested as one.
#[derive(Debug, PartialEq)]
enum Decision {
    Stop,
    RestartNow,
    RestartAt {
        wake_at_ms: u128,
    },
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
        (Some(INTENT_EXIT_CODE), Some(Intent::Dormant { wake_at_ms })) => {
            Decision::RestartAt { wake_at_ms }
        }
        _ => Decision::RestartAfterCrash,
    }
}

/// A deliberately tiny JSON cursor for the exact flat object the TypeScript writer emits.
///
/// This is still dependency-free, but unlike substring search it consumes the WHOLE document. That
/// distinction is the fail-safe boundary: `{"kind":"shutdown"` and `wakeAtMs:12garbage` must not
/// become valid instructions merely because a recognisable prefix appeared before the corruption.
struct JsonCursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> JsonCursor<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            at: 0,
        }
    }

    fn whitespace(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.at += 1;
        }
    }

    fn take(&mut self, byte: u8) -> bool {
        self.whitespace();
        if self.bytes.get(self.at) != Some(&byte) {
            return false;
        }
        self.at += 1;
        true
    }

    /// Protocol strings are unescaped identifiers. Reject escapes rather than implement a partial
    /// decoder whose edge cases could make malformed input look authoritative.
    fn string(&mut self) -> Option<String> {
        self.whitespace();
        if self.bytes.get(self.at) != Some(&b'"') {
            return None;
        }
        self.at += 1;
        let start = self.at;
        while let Some(byte) = self.bytes.get(self.at).copied() {
            match byte {
                b'"' => {
                    let value = std::str::from_utf8(&self.bytes[start..self.at])
                        .ok()?
                        .to_string();
                    self.at += 1;
                    return Some(value);
                }
                b'\\' | 0..=0x1f => return None,
                _ => self.at += 1,
            }
        }
        None
    }

    fn number(&mut self) -> Option<u128> {
        self.whitespace();
        let start = self.at;
        while matches!(self.bytes.get(self.at), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        if self.at == start {
            return None;
        }
        // JSON has no octal spelling: zero is valid, a multi-digit integer beginning with zero is
        // malformed and must not be accepted as a plausible prefix.
        if self.at - start > 1 && self.bytes[start] == b'0' {
            return None;
        }
        std::str::from_utf8(&self.bytes[start..self.at])
            .ok()?
            .parse()
            .ok()
    }

    fn finished(&mut self) -> bool {
        self.whitespace();
        self.at == self.bytes.len()
    }
}

/// Parse and fully consume an intent document. Unknown/duplicate fields, trailing bytes, truncated
/// objects and values of the wrong type all return `None`, which the classifier reads as a crash.
fn parse_intent(text: &str) -> Option<Intent> {
    let mut cursor = JsonCursor::new(text);
    if !cursor.take(b'{') {
        return None;
    }
    if cursor.take(b'}') {
        return None;
    }

    let mut kind: Option<String> = None;
    let mut wake_at_ms: Option<u128> = None;
    loop {
        let key = cursor.string()?;
        if !cursor.take(b':') {
            return None;
        }
        match key.as_str() {
            "kind" if kind.is_none() => kind = Some(cursor.string()?),
            "wakeAtMs" if wake_at_ms.is_none() => wake_at_ms = Some(cursor.number()?),
            _ => return None,
        }
        if cursor.take(b'}') {
            break;
        }
        if !cursor.take(b',') {
            return None;
        }
    }
    if !cursor.finished() {
        return None;
    }

    match (kind.as_deref(), wake_at_ms) {
        (Some("shutdown"), None) => Some(Intent::Shutdown),
        (Some("restart"), None) => Some(Intent::Restart),
        (Some("dormant"), Some(wake_at_ms)) => Some(Intent::Dormant { wake_at_ms }),
        _ => None,
    }
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

/// How long the loop still owes before it may start a child again.
///
/// A pure function of (when the previous start began, now) so the floor can be reasoned about and
/// tested without spawning anything. `None` is the first start of the process, which owes nothing.
fn restart_gap_ms(previous_start_ms: Option<u128>, now: u128) -> u64 {
    let previous = match previous_start_ms {
        Some(value) => value,
        // The first start of the process owes nothing.
        None => return 0,
    };
    // `saturating_sub` on both halves: a clock that jumped BACKWARDS must read as "no time has
    // passed", i.e. wait the full gap — never as a negative that wraps into a very long sleep.
    let elapsed = now.saturating_sub(previous);
    (MIN_RESTART_GAP_MS as u128).saturating_sub(elapsed) as u64
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Sleep until `wake_at_ms`, in short ticks, so the wait stays interruptible and a clock that jumps
/// backwards cannot park the instance for years.
fn sleep_until(wake_at_ms: u128, wake_now: &Path) {
    // A marker belongs only to a dormancy already in progress. One left while the child was active,
    // or across a watchdog restart, must not cancel a future sleep it could not have referred to.
    // Clearing at the sleep boundary gives markers created AFTER this point their intended meaning.
    let _ = fs::remove_file(wake_now);
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
                state_dir = Some(PathBuf::from(
                    argv.get(index + 1).ok_or("--state needs a directory")?,
                ));
                index += 2;
            }
            "--" => {
                let command: Vec<String> = argv[index + 1..].to_vec();
                if command.is_empty() {
                    return Err("no command after --".into());
                }
                return Ok(Args {
                    state_dir: state_dir.ok_or("--state is required")?,
                    command,
                });
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
    let mut last_start_ms: Option<u128> = None;
    loop {
        // 🔴 THE RATE FLOOR, at the ONLY place a child is ever started — see MIN_RESTART_GAP_MS.
        // Every route back here passes through it: a crash, an operator restart, a past-dated
        // dormancy, a command that could not be spawned at all. A start that lasted longer than the
        // gap pays nothing, so this costs a healthy instance exactly zero.
        let owed = restart_gap_ms(last_start_ms, now_ms());
        if owed > 0 {
            std::thread::sleep(Duration::from_millis(owed));
        }

        // 🔴 Clear BEFORE spawning. Together with consuming on read this is what makes an intent
        // single-use: a file that survived a hard kill cannot speak for the run about to start.
        let _ = fs::remove_file(&intent_path);

        let started = now_ms();
        last_start_ms = Some(started);
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
                // half-finished binary replacement, so it is retried on the ladder rather than fatal.
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
            // ⚠️ Neither of these arms resets `attempt`, and that is the fix rather than an
            // omission. The reset rule is the one HEALTHY_AFTER_MS documents and the block above
            // applies: the ladder clears when the last start ACHIEVED something. Clearing it here
            // as well meant a child alternating a fast intent-restart with a crash never climbed
            // the ladder at all — the counter was wiped on every other iteration.
            Decision::RestartNow => {
                eprintln!("[watchdog] child asked for a restart");
            }
            Decision::RestartAt { wake_at_ms } => {
                let now = now_ms();
                let seconds = wake_at_ms.saturating_sub(now) / 1000;
                eprintln!("[watchdog] child went dormant — waking in {seconds}s");
                sleep_until(wake_at_ms, &wake_now);
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
        assert_eq!(
            classify(Some(0), Some(Intent::Shutdown)),
            Decision::RestartAfterCrash
        );
        assert_eq!(
            classify(Some(1), Some(Intent::Shutdown)),
            Decision::RestartAfterCrash
        );
        assert_eq!(
            classify(Some(1), Some(Intent::Dormant { wake_at_ms: 42 })),
            Decision::RestartAfterCrash
        );
    }

    #[test]
    fn the_clean_code_without_an_intent_is_a_crash() {
        assert_eq!(
            classify(Some(INTENT_EXIT_CODE), None),
            Decision::RestartAfterCrash
        );
    }

    #[test]
    fn a_signal_kill_is_a_crash_even_with_an_intent() {
        assert_eq!(
            classify(None, Some(Intent::Shutdown)),
            Decision::RestartAfterCrash
        );
    }

    #[test]
    fn both_signals_agreeing_is_honoured() {
        assert_eq!(
            classify(Some(INTENT_EXIT_CODE), Some(Intent::Shutdown)),
            Decision::Stop
        );
        assert_eq!(
            classify(Some(INTENT_EXIT_CODE), Some(Intent::Restart)),
            Decision::RestartNow
        );
        assert_eq!(
            classify(
                Some(INTENT_EXIT_CODE),
                Some(Intent::Dormant { wake_at_ms: 99 })
            ),
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
        assert_eq!(
            parse_intent(r#"{"kind":"shutdown"}"#),
            Some(Intent::Shutdown)
        );
        assert_eq!(parse_intent(r#"{"kind":"restart"}"#), Some(Intent::Restart));
        assert_eq!(
            parse_intent(r#"{"kind":"dormant","wakeAtMs":1787961234567}"#),
            Some(Intent::Dormant {
                wake_at_ms: 1787961234567
            })
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
        assert_eq!(
            parse_intent(r#"{"kind":"shutdown""#),
            None,
            "a full value in a truncated object"
        );
        assert_eq!(
            parse_intent(r#"{"kind":"shutdown"}garbage"#),
            None,
            "trailing bytes"
        );
        assert_eq!(
            parse_intent(r#"{"kind":"hibernate"}"#),
            None,
            "a kind from a future version"
        );
        assert_eq!(
            parse_intent(r#"{"kind":"dormant"}"#),
            None,
            "dormant with no wake time"
        );
        assert_eq!(
            parse_intent(r#"{"kind":"dormant","wakeAtMs":"soon"}"#),
            None
        );
        assert_eq!(
            parse_intent(r#"{"kind":"dormant","wakeAtMs":-5}"#),
            None,
            "a negative instant"
        );
        assert_eq!(
            parse_intent(r#"{"kind":"dormant","wakeAtMs":5oops}"#),
            None,
            "numeric suffix"
        );
        assert_eq!(
            parse_intent(r#"{"kind":"dormant","wakeAtMs":05}"#),
            None,
            "leading zero"
        );
        assert_eq!(
            parse_intent(r#"{"kind":"shutdown","extra":1}"#),
            None,
            "unknown field"
        );
        assert_eq!(
            parse_intent(r#"{"kind":"shutdown","kind":"restart"}"#),
            None,
            "duplicate field"
        );
        assert_eq!(
            parse_intent(r#"{"kind":"shutdown",}"#),
            None,
            "trailing comma"
        );
    }

    #[test]
    fn a_stale_wake_marker_does_not_cancel_a_later_dormancy() {
        let directory = std::env::temp_dir().join(format!(
            "novaclaw-watchdog-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&directory).unwrap();
        let marker = directory.join("wake-now");
        fs::write(&marker, b"stale").unwrap();
        sleep_until(now_ms() + 2, &marker);
        assert!(
            !marker.exists(),
            "the stale marker must be consumed before the new sleep begins"
        );
        let _ = fs::remove_dir_all(directory);
    }

    // 🔴 THE RATE FLOOR. The ladder is consulted by ONE decision arm; these assertions are about the
    // bound that no arm can avoid, because it sits at the single place a child is started.
    #[test]
    fn an_operator_restart_still_pays_the_floor() {
        // The concrete case: a child that boots, fails to apply an update, writes an intent and
        // exits 77 in 50 ms. `RestartNow` consults no ladder, so without a floor this is a 20 Hz
        // spawn loop. The floor is charged against the START, not against the exit, so a 50 ms life
        // still owes almost the whole gap.
        let started = 1_000_000u128;
        assert_eq!(
            restart_gap_ms(Some(started), started + 50),
            MIN_RESTART_GAP_MS - 50
        );
    }

    #[test]
    fn a_past_dated_dormancy_still_pays_the_floor() {
        // `sleep_until` returns immediately for a wake time already behind us — a clock jump, or a
        // child computing its wake from a stale base — so the dormancy arm reaches the top of the
        // loop with no delay of its own. Same floor, same reason.
        let started = 42u128;
        assert_eq!(restart_gap_ms(Some(started), started), MIN_RESTART_GAP_MS);
    }

    #[test]
    fn the_floor_costs_a_healthy_instance_nothing() {
        let started = 1_000u128;
        let gap = MIN_RESTART_GAP_MS as u128;
        assert_eq!(restart_gap_ms(Some(started), started + gap), 0);
        assert_eq!(restart_gap_ms(Some(started), started + HEALTHY_AFTER_MS), 0);
        // The first start of the process owes nothing at all.
        assert_eq!(restart_gap_ms(None, 0), 0);
    }

    #[test]
    fn a_backwards_clock_waits_rather_than_wrapping() {
        // If "now" reads earlier than the start we recorded, the elapsed time must clamp to zero and
        // the caller must wait the full gap — an unsigned wrap here would park the instance for
        // millions of years, which is the failure mode `sleep_until`'s own tick guard exists for.
        assert_eq!(restart_gap_ms(Some(5_000), 1_000), MIN_RESTART_GAP_MS);
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
