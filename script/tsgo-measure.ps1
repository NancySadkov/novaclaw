<#
  Run one tsgo invocation and report its PEAK commit charge, plus wall time.

  Sampling, not a final read: a runaway is only visible while it runs. `Get-Process` after exit tells
  you nothing, which is part of why the 10 GB spike went unnoticed until the box locked up.
#>
param(
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$Arguments,
  [hashtable]$Env = @{},
  [int]$SampleMs = 250
)

foreach ($key in $Env.Keys) { Set-Item -Path "Env:$key" -Value $Env[$key] }

$tsgo = "C:\Users\nangl\d\code\llm\novaclaw\node_modules\.bun\@typescript+native-preview-win32-x64@7.0.0-dev.20251207.1\node_modules\@typescript\native-preview-win32-x64\lib\tsgo.exe"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $tsgo -ArgumentList $Arguments -WorkingDirectory $WorkDir -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\tsgo-out.txt" -RedirectStandardError "$env:TEMP\tsgo-err.txt"

$peak = 0
$peakWs = 0
while (-not $proc.HasExited) {
  try {
    $p = Get-Process -Id $proc.Id -ErrorAction Stop
    $mb = [math]::Round($p.PagedMemorySize64 / 1MB)
    $ws = [math]::Round($p.WorkingSet64 / 1MB)
    if ($mb -gt $peak) { $peak = $mb }
    if ($ws -gt $peakWs) { $peakWs = $ws }
  } catch {}
  Start-Sleep -Milliseconds $SampleMs
}
$sw.Stop()

foreach ($key in $Env.Keys) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue }

[pscustomobject]@{
  Args        = $Arguments
  EnvUsed     = ($Env.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join " "
  PeakCommitMB = $peak
  PeakWSMB    = $peakWs
  Seconds     = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  ExitCode    = $proc.ExitCode
}

