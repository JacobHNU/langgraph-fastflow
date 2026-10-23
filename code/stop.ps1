$ErrorActionPreference = 'Stop'
$demoPidFile = Join-Path $PSScriptRoot 'data/server.pid'
if (-not (Test-Path -LiteralPath $demoPidFile)) { Write-Host 'No managed server PID file found.'; return }
$demoServerId = [int](Get-Content -LiteralPath $demoPidFile)
$demoServerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$demoServerId" -ErrorAction SilentlyContinue
if ($demoServerProcess -and $demoServerProcess.CommandLine -match 'uvicorn.+backend.main:app') {
    taskkill.exe /PID $demoServerId /T /F | Out-Null
    Write-Host 'Workflow Studio stopped. Persistent data was retained.'
} else { Write-Host 'Managed server is already stopped.' }
Remove-Item -LiteralPath $demoPidFile -ErrorAction SilentlyContinue
