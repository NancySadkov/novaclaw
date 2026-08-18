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
#>
param(
  [int]$CeilingMB = 4096,
  [int]$IntervalSeconds = 2,
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
Set-Content -Path $pidFile -Value $PID
Register-EngineEvent PowerShell.Exiting -Action { Remove-Item $pidFile -ErrorAction SilentlyContinue } | Out-Null

Write-GuardLog "guard started (pid $PID): ceiling ${CeilingMB} MB, polling every ${IntervalSeconds}s"

while ($true) {
  try {
    $procs = Get-Process tsgo, tsgolint -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
      $mb = [math]::Round($p.PagedMemorySize64 / 1MB)
      if ($mb -gt $CeilingMB) {
        Write-GuardLog "KILLING pid $($p.Id) ($($p.ProcessName)) at ${mb} MB commit — over the ${CeilingMB} MB ceiling. This is a BUG, not load."
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { Write-GuardLog "  kill failed: $($_.Exception.Message)" }
      }
    }
  } catch {
    Write-GuardLog "poll error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $IntervalSeconds
}
