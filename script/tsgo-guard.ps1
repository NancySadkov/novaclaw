<#
  Kill any tsgo.exe that exceeds a memory ceiling, and say so loudly.

  WHY THIS EXISTS (2026-08-18): a single `tsgo -b` reached >10 GB on this box and locked it up hard,
  taking the whole session with it. A typechecker does not legitimately need 10 GB for this repo, so
  crossing the ceiling is treated as a BUG, not as load — the process is killed and the event is
  recorded rather than being absorbed as "typechecking is slow today".

  WHY A KILLER AND NOT JUST GOMEMLIMIT: `GOMEMLIMIT` is a SOFT limit. It makes Go's GC run
  continuously as the heap approaches it, which is the right preventive measure, but if the live set
  genuinely exceeds the limit Go will still allocate past it rather than fail. So the env vars reduce
  the chance of a runaway and THIS is the backstop that bounds the damage when one happens anyway.

  Commit charge (PagedMemorySize64), not working set: a runaway shows up as commit long before the
  working set reflects it, and commit is what actually exhausts the box.

  ─── THE LOOP BOUNDS ITSELF, because nothing else can reach it ──────────────────────────────────────

  🔴 **This loop used to be `while ($true)` with no way out at all** — no break, no timeout, no owner.
  Measured 2026-09-03: pid 22292 started at 03:30, the last typecheck finished at 19:02, and it was
  still polling WMI at 21:22 — 17.9 hours, of which 2.3 were useful. The log shows one such guard per
  boot since 2026-08-18, each ending only when the machine restarted or a human killed it.

  ⚠️ **That was not an accident of the loop, it is the price of the detach.** `tsgo.ts` launches this
  through `Start-Process` ON PURPOSE, so the guard outlives the wrapper and is already warm when the
  next `tsgo` starts — a helper that must boot first cannot catch a run that finishes in under a
  second. The half that was never written is the other one: something that ends it. A detached
  process has no parent to die with, and nothing in either repository stops it.

  ⚠️ **So the bound is a property of the LOOP, not of its caller** — the same conclusion
  `script/lib/peak-sampler.ts` reached, for the same reason, after the same shape of orphan. That
  sampler watches its PARENT, which this guard cannot do: it is deliberately parentless. What it
  serves instead is the `tsgo` process, so subject-idleness is its analogue of parent liveness.

  Three bounds, because they fail differently:

   · **Subject idle** — no `tsgo`/`tsgolint` seen for `-IdleExitSeconds`. This is the ask: the guard
     ends when the thing it guards has finished. The grace window is what keeps the detach worth
     having, since back-to-back typechecks (a `--only=typecheck` run walks sixteen packages) reuse
     one warm guard instead of paying a startup per package.
   · **Ownership** — the pid file must still name THIS process. A guard that has been superseded, or
     whose pid file a human deleted while reaping it, stops rather than lingering invisibly.
   · **An absolute lifetime ceiling** — `-MaxLifetimeHours`. Idleness is measured from observations,
     so a bug in the observation would make "idle" unreachable; this makes "forever" unreachable
     regardless of what the other two do.

  ⚠️ **The pid file carries a HEARTBEAT, not just a pid, and `tsgo.ts` reads both.** Now that this
  process exits routinely, a stale pid file is the normal case rather than a rarity — and PID reuse
  on Windows is real (`peak-sampler.ts` records one number appearing twice inside a single gate). A
  liveness test alone would be satisfied by a stranger wearing the dead guard's number, and the guard
  would then never be started while everything looked healthy. A fresh timestamp is what distinguishes
  "the guard is up" from "some process has that pid".
#>
param(
  [int]$CeilingMB = 4096,
  [int]$IntervalSeconds = 2,
  # Long enough that the packages of one typecheck run share a guard, short enough that an idle
  # machine reaps it. Measured: the gap between packages in `--only=typecheck` is sub-second.
  [int]$IdleExitSeconds = 90,
  [int]$MaxLifetimeHours = 12,
  # What this guard is FOR, named rather than buried in the poll, so a test can point it at a subject
  # it controls. A bound is only real if something has watched it fire, and watching it fire against
  # the live `tsgo` name would mean racing whatever else on this box is typechecking.
  [string[]]$ProcessNames = @('tsgo', 'tsgolint'),
  [string]$LogPath = "$PSScriptRoot\..\tmp\tsgo-guard.log"
)

$dir = Split-Path -Parent $LogPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

function Write-GuardLog([string]$message) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
  Add-Content -Path $LogPath -Value $line
  Write-Output $line
}

# A heartbeat file, so anyone can ask "is the guard up?" without listing processes.
# ⚠️ Detecting the guard by scanning command lines is a TRAP: the scanning command's OWN command line
# contains the script name, so the query matches itself and always answers "yes". That bug shipped in
# the wrapper's first version and meant the guard was never started, silently.
$pidFile = Join-Path (Split-Path -Parent $LogPath) "tsgo-guard.pid"

function Write-Heartbeat([switch]$Initial) {
  # `<pid> <unix ms>`. The pid alone cannot be trusted once this process exits routinely; see header.
  $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($Initial) {
    Set-Content -Path $pidFile -Value ("{0} {1}" -f $PID, $stamp)
    return
  }
  # Hold one handle across the ownership read and heartbeat write. An earlier tick's ownership
  # check cannot authorize a later write: process enumeration may take long enough for a successor
  # to take over. FileShare.Read excludes writers and deletion during this short update.
  $record = [System.IO.File]::Open($pidFile, 'Open', 'ReadWrite', 'Read')
  try {
    $reader = [System.IO.StreamReader]::new($record, [System.Text.Encoding]::UTF8, $true, 1024, $true)
    try { $held = ($reader.ReadToEnd() -split '\s+')[0] } finally { $reader.Dispose() }
    if ($held -ne "$PID") { return }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(("{0} {1}" -f $PID, $stamp))
    $record.Position = 0
    $record.Write($bytes, 0, $bytes.Length)
    $record.SetLength($bytes.Length)
  } finally { $record.Dispose() }
}

# Only ever remove a pid file that still names US. A successor's record is not ours to delete.
function Remove-OwnPidFile {
  try {
    if (Test-Path $pidFile) {
      $held = ((Get-Content $pidFile -Raw -ErrorAction Stop) -split '\s+')[0]
      if ($held -eq "$PID") { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
    }
  } catch {}
}

Write-Heartbeat -Initial
Register-EngineEvent PowerShell.Exiting -Action { Remove-OwnPidFile } | Out-Null

Write-GuardLog "guard started (pid $PID): watching $($ProcessNames -join ', '), ceiling ${CeilingMB} MB, polling every ${IntervalSeconds}s, idle exit ${IdleExitSeconds}s"

$startedAt = Get-Date
# Seeded at launch, not at zero: `tsgo.ts` starts this guard BEFORE it spawns the process it guards,
# so a guard that demanded to see one immediately would exit during its own startup.
$lastSeen = Get-Date
$reason = $null

try {
  while ($true) {
    try {
      # 1. Ownership. A superseded guard, or one whose record was cleared by hand, stops here.
      if (-not (Test-Path $pidFile)) { $reason = "pid file is gone — reaped by hand"; break }
      $held = ((Get-Content $pidFile -Raw -ErrorAction Stop) -split '\s+')[0]
      if ($held -ne "$PID") { $reason = "superseded: the pid file now names $held"; break }

      # 2. The actual job.
      $procs = @(Get-Process -Name $ProcessNames -ErrorAction SilentlyContinue)
      if ($procs.Count -gt 0) {
        $lastSeen = Get-Date
        foreach ($p in $procs) {
          $mb = [math]::Round($p.PagedMemorySize64 / 1MB)
          if ($mb -gt $CeilingMB) {
            Write-GuardLog "KILLING pid $($p.Id) ($($p.ProcessName)) at ${mb} MB commit — over the ${CeilingMB} MB ceiling. This is a BUG, not load."
            try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { Write-GuardLog "  kill failed: $($_.Exception.Message)" }
          }
        }
      }

      # 3. The bounds. Idle first, because it is the one that fires in normal use.
      $idle = [int]((Get-Date) - $lastSeen).TotalSeconds
      if ($idle -ge $IdleExitSeconds) { $reason = "no tsgo for ${idle}s — the run it guards has finished"; break }
      $lifeHours = ((Get-Date) - $startedAt).TotalHours
      if ($lifeHours -ge $MaxLifetimeHours) { $reason = "hit the ${MaxLifetimeHours}h lifetime ceiling"; break }

      Write-Heartbeat
    } catch {
      Write-GuardLog "poll error: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  Write-GuardLog "guard stopping (pid $PID): $(if ($reason) { $reason } else { 'terminated' })"
  Remove-OwnPidFile
}
