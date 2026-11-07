# Start the API (and its local PGlite database bridge) detached from the caller's job object.
# Start-Process children are killed when the parent shell exits (sandbox kill-on-close),
# and sandboxed processes cannot write to the E: uploads dir. Run this script through
# Win32_Process.Create to escape the job object; inside it, Start-Process own children survive.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$logDir = Join-Path (Split-Path -Parent (Split-Path -Parent $root)) 'data'
if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

function PortListening($port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

# 1) database bridge on :5432 (PGlite over TCP)
if (-not (PortListening 5432)) {
  $dbProc = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -like '*pg-server.mjs*'
  })
  if ($dbProc.Count -gt 0) {
    Write-Output ('db bridge already running (pid ' + $dbProc[0].ProcessId + '), waiting for port 5432')
  } else {
    $env:PG_DATA_DIR = (Join-Path $logDir 'pgdata')
    $db = Start-Process -FilePath $node -ArgumentList 'pg-server.mjs' -WorkingDirectory $root `
      -RedirectStandardOutput (Join-Path $logDir 'db.out.log') `
      -RedirectStandardError (Join-Path $logDir 'db.err.log') -WindowStyle Hidden -PassThru
    Write-Output ('db bridge started (pid ' + $db.Id + ')')
  }
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline -and -not (PortListening 5432)) { Start-Sleep -Seconds 2 }
  if (-not (PortListening 5432)) {
    throw ('db bridge did not open port 5432 in time; see ' + (Join-Path $logDir 'db.err.log'))
  }
  Write-Output 'db bridge ready (:5432)'
}

# 2) API on :3000
$existing = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -like '*dist*main.js*'
})
if ($existing.Count -gt 0) {
  Write-Output ('API already running (pid ' + $existing[0].ProcessId + ')')
  exit 0
}

$outLog = Join-Path $logDir 'api.out.log'
$errLog = Join-Path $logDir 'api.err.log'
$p = Start-Process -FilePath $node -ArgumentList 'dist/main.js' -WorkingDirectory $root `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 1
Write-Output ('API started (pid ' + $p.Id + ') logs: ' + $outLog)
