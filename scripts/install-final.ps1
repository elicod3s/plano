# Install the final PLANO build over the installed app (win-unpacked copy, per CLAUDE.md —
# the NSIS Setup.exe is unreliable on this machine).
#
# WHY this script exists: the Agent Host daemon (which hosts every live terminal/agent,
# including this conversation) holds a lock on the INSTALLED app's files
# (PLANO.exe + resources/app.asar). Overwriting them requires the daemon to exit, which
# ends the PTY sessions it hosts. THIS IS EXPECTED — pi conversations are persisted
# incrementally under ~/.pi/agent/sessions and resume with `pi --session <id>`.
#
# Safety: verifies the source build, backs up the old install, retries until file locks
# release, verifies the result, and only deletes backups after a successful verify.
# Re-runnable (idempotent).

param(
  [string]$Source = "D:\Tools\Plano\release\win-unpacked",
  [string]$Target = "$env:LOCALAPPDATA\Programs\PLANO",
  [switch]$Launch = $false,
  [int]$WaitLockMs = 60000
)

$ErrorActionPreference = 'Stop'
function Fail($msg) { Write-Host "INSTALL-FAIL: $msg"; exit 1 }

# ── 1. pre-flight ──
if (-not (Test-Path "$Source\PLANO.exe")) { Fail "source build missing: $Source\PLANO.exe" }
if (-not (Test-Path "$Source\resources\app.asar")) { Fail "source asar missing" }
if (-not (Test-Path "$Target\PLANO.exe")) { Fail "target install missing: $Target" }

# ── 2. identify + stop the Agent Host daemon that locks the target files ──
$hostFile = "$env:APPDATA\plano\agent-host.json"
$daemonPid = $null
if (Test-Path $hostFile) {
  try {
    $hostInfo = Get-Content $hostFile -Raw | ConvertFrom-Json
    if ($hostInfo.pid) {
      $proc = Get-Process -Id $hostInfo.pid -ErrorAction SilentlyContinue
      if ($proc) {
        # Only stop it if it is actually the PLANO daemon (not some unrelated process).
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($hostInfo.pid)" -ErrorAction SilentlyContinue
        if ($cim -and $cim.CommandLine -match 'daemon\.js') {
          $daemonPid = $hostInfo.pid
        }
      }
    }
  } catch { Write-Host "note: could not read host file ($_)" }
}
if ($daemonPid) {
  Write-Host "stopping Agent Host daemon PID $daemonPid (hosts live terminal sessions)..."
  Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue
  # Orphaned agent processes (pi/claude/node) linger after the PTY dies; leave them to the
  # user — the resume path is `pi --session <id>`. They hold no locks on the app files.
} else {
  Write-Host "no running Agent Host daemon found — proceeding"
}

# ── 3. wait for the target files to release (daemon holds them open) ──
function Is-Locked($path) {
  try { $s = [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None'); $s.Close(); return $false }
  catch { return $true }
}
$deadline = (Get-Date).AddMilliseconds($WaitLockMs)
while ((Is-Locked "$Target\resources\app.asar") -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
}
if (Is-Locked "$Target\resources\app.asar") { Fail "app.asar still locked after $WaitLockMs ms" }

# ── 4. back up the current install ──
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$Target.old-$stamp"
Write-Host "backing up current install -> $backup"
if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
Move-Item $Target $backup

# ── 5. copy the new build ──
Write-Host "copying $Source -> $Target"
Copy-Item $Source $Target -Recurse -Force
if (-not (Test-Path "$Target\PLANO.exe")) { Move-Item $backup $Target; Fail "copy failed (no PLANO.exe) — rolled back" }
if (-not (Test-Path "$Target\resources\app.asar")) { Move-Item $backup $Target; Fail "copy failed (no app.asar) — rolled back" }

# ── 6. verify sizes match the source (copy integrity) ──
$srcAsar = (Get-Item "$Source\resources\app.asar").Length
$dstAsar = (Get-Item "$Target\resources\app.asar").Length
$srcExe  = (Get-Item "$Source\PLANO.exe").Length
$dstExe  = (Get-Item "$Target\PLANO.exe").Length
if ($srcAsar -ne $dstAsar -or $srcExe -ne $dstExe) {
  Move-Item $backup $Target
  Fail "integrity mismatch (asar $srcAsar vs $dstAsar, exe $srcExe vs $dstExe) — rolled back"
}

# ── 7. clean up ──
Write-Host "install OK. removing backup..."
Remove-Item $backup -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "INSTALL-OK $Target"

if ($Launch) {
  Write-Host "launching PLANO..."
  Start-Process "$Target\PLANO.exe"
}
