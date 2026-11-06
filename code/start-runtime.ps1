param(
    [int]$Port = 8010,
    [string]$DataDir = 'data/runtime',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$runtimeRoot = $PSScriptRoot
Push-Location $runtimeRoot
try {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'Install uv first: https://docs.astral.sh/uv/' }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is occupied." }
    uv sync --locked --no-dev --python 3.12
    if ($LASTEXITCODE -ne 0) { throw 'Runtime dependency installation failed.' }
    $runtimeDataRoot = if ([IO.Path]::IsPathRooted($DataDir)) { [IO.Path]::GetFullPath($DataDir) } else { [IO.Path]::GetFullPath((Join-Path $runtimeRoot $DataDir)) }
    New-Item -ItemType Directory -Path (Join-Path $runtimeDataRoot 'logs') -Force | Out-Null
    $runtimeProcess = Start-Process -FilePath (Join-Path $runtimeRoot '.venv/Scripts/python.exe') -ArgumentList @('-m','backend.headless','--port',"$Port",'--data-dir',('"' + $runtimeDataRoot + '"')) -WorkingDirectory $runtimeRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDataRoot 'logs/runtime.out.log') -RedirectStandardError (Join-Path $runtimeDataRoot 'logs/runtime.err.log') -PassThru
    $runtimeProcess.Id | Set-Content -LiteralPath (Join-Path $runtimeDataRoot 'runtime.pid') -Encoding ascii
    $runtimeDeadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 300
        try { $runtimeHealth = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 1 } catch { $runtimeHealth = $null }
    } until (($runtimeHealth -and $runtimeHealth.service -eq 'fastflow-runtime') -or (Get-Date) -gt $runtimeDeadline)
    if (-not $runtimeHealth -or $runtimeHealth.service -ne 'fastflow-runtime') { throw "Runtime startup failed. See $runtimeDataRoot/logs/runtime.err.log" }
    Write-Host "FastFlow Runtime: http://127.0.0.1:$Port" -ForegroundColor Green
    Write-Host "Data: $runtimeDataRoot"
    if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port" }
} finally { Pop-Location }
