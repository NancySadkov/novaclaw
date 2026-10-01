param([Parameter(Mandatory = $true)][string]$BuildScript, [string]$BuildArgument = '')
$ErrorActionPreference = 'Stop'
if ([IntPtr]::Size -ne 8 -or $env:OS -ne 'Windows_NT') { throw 'The build memory boundary requires Windows x64' }
$policy = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'lib\build-memory.json') -Raw | ConvertFrom-Json
if ($policy.budgetMiB -ne 1280) { throw 'The build memory budget must be 1280 MiB' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BuildMemoryJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int information, byte[] data, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int information, byte[] data, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();
    public static void Require(bool result, string operation) {
        if (!result) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
}
'@
$jobName = 'Local\NovaClaw.BuildMemory.' + $PID + '.' + [Guid]::NewGuid().ToString()
$job = [BuildMemoryJob]::CreateJobObjectW([IntPtr]::Zero, $jobName)
[BuildMemoryJob]::Require($job -ne [IntPtr]::Zero, 'CreateJobObjectW')
$jobInformation = New-Object byte[] 144
[BitConverter]::GetBytes([uint32]0x2200).CopyTo($jobInformation, 16)
[BitConverter]::GetBytes([uint64]($policy.budgetMiB * 1MB * 3 / 4)).CopyTo($jobInformation, 120)
[BuildMemoryJob]::Require([BuildMemoryJob]::SetInformationJobObject($job, 9, $jobInformation, 144), 'SetInformationJobObject')
[BuildMemoryJob]::Require([BuildMemoryJob]::AssignProcessToJobObject($job, [BuildMemoryJob]::GetCurrentProcess()), 'AssignProcessToJobObject')
$env:NOVACLAW_BUILD_MEMORY_JOB = $jobName
$env:NODE_OPTIONS = '--max-old-space-size=' + $policy.nodeHeapMiB + ' --max-semi-space-size=' + $policy.nodeSemiSpaceMiB
$env:GOMEMLIMIT = [string]$policy.goMemoryMiB + 'MiB'
$env:GOMAXPROCS = '2'
$env:UV_THREADPOOL_SIZE = '2'
$env:CARGO_BUILD_JOBS = '1'
$env:RAYON_NUM_THREADS = '1'
$remainingMiB = [Math]::Max(0, $policy.budgetMiB * 3 / 4 - (Get-Process -Id $PID).WorkingSet64 / 1MB)
& bun --smol (Join-Path $PSScriptRoot 'guard.ts') 'a desktop build' --bounded-build --min-free-gb ($remainingMiB / 1024)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
[GC]::Collect()
& $env:ComSpec /d /c "`"$BuildScript`" $BuildArgument"
$buildExitCode = $LASTEXITCODE
[BuildMemoryJob]::Require([BuildMemoryJob]::QueryInformationJobObject($job, 9, $jobInformation, 144, [IntPtr]::Zero), 'QueryInformationJobObject')
$peakBytes = [BitConverter]::ToUInt64($jobInformation, 136)
$memory = @{
    command = @($BuildScript, $BuildArgument)
    exitCode = $buildExitCode
    limitBytes = [BitConverter]::ToUInt64($jobInformation, 120)
    peakBytes = $peakBytes
    flags = [BitConverter]::ToUInt32($jobInformation, 16)
}
$scratch = Join-Path $PSScriptRoot '..\tmp'
[IO.Directory]::CreateDirectory($scratch) | Out-Null
[IO.File]::AppendAllText((Join-Path $scratch 'build-memory.jsonl'), ($memory | ConvertTo-Json -Compress) + [Environment]::NewLine)
Write-Host ('Build process tree peak: {0:N1} MiB / 1280 MiB' -f ($peakBytes / 1MB))
if ($peakBytes -gt $policy.budgetMiB * 1MB) { throw 'The build exceeded the 1280 MiB budget' }
if ($buildExitCode -ne 0) { Write-Error 'Build failed under the 1280 MiB process tree limit; no uncapped retry will run.' -ErrorAction Continue }
exit $buildExitCode
