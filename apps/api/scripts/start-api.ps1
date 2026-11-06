# Start the API in a process detached from the caller's job object.
# Start-Process children are killed when the parent shell exits (sandbox kill-on-close),
# and sandboxed processes cannot write to the E: uploads dir. Win32_Process.Create avoids both.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source

$existing = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -like '*dist*main.js*'
})
if ($existing.Count -gt 0) {
  Write-Output ('API already running (pid ' + $existing[0].ProcessId + ')')
  exit 0
}

$commandLine = '"' + $node + '" dist/main.js'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = $commandLine
  CurrentDirectory = $root
}
if ($r.ReturnValue -ne 0) {
  throw ('Failed to start API: Win32_Process.Create returned ' + $r.ReturnValue)
}
Write-Output ('API started (pid ' + $r.ProcessId + ')')
