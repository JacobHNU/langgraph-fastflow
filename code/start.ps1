param([int]$Port = 8000, [switch]$Rebuild, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$demoRoot = $PSScriptRoot
Push-Location -LiteralPath $demoRoot
try {
    if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
        uv sync --frozen --link-mode copy
        if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
    }
    if ($Rebuild -or -not (Test-Path -LiteralPath 'frontend/dist/index.html')) {
        Push-Location -LiteralPath 'frontend'
        try {
            npm.cmd ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
            npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
        } finally { Pop-Location }
    }
    $demoUrl = "http://127.0.0.1:$Port"
    try { $existing = Invoke-RestMethod "$demoUrl/api/health" -TimeoutSec 2 } catch { $existing = $null }
    if ($existing -and $existing.service -eq 'workflow-studio') {
        Write-Host "Already running: $demoUrl" -ForegroundColor Green
        if (-not $NoBrowser) { Start-Process $demoUrl }
        return
    }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $Port is occupied. Run ./start.ps1 -Port 8001 to choose another port."
    }
    New-Item -ItemType Directory -Path 'data/logs' -Force | Out-Null
    $demoProcess = Start-Process -FilePath (Join-Path $demoRoot '.venv/Scripts/python.exe') -ArgumentList @('-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',"$Port") -WorkingDirectory $demoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $demoRoot 'data/logs/backend.out.log') -RedirectStandardError (Join-Path $demoRoot 'data/logs/backend.err.log') -PassThru
    $demoProcess.Id | Set-Content -LiteralPath (Join-Path $demoRoot 'data/server.pid') -Encoding ascii
    $demoDeadline = (Get-Date).AddSeconds(30)
    $ready = $false
    do {
        Start-Sleep -Milliseconds 300
        try { $response = Invoke-RestMethod "$demoUrl/api/health" -TimeoutSec 1; $ready = $response.service -eq 'workflow-studio' } catch { $ready = $false }
    } until ($ready -or (Get-Date) -gt $demoDeadline)
    if (-not $ready) { throw 'Server did not start. See data/logs/backend.err.log.' }
    Write-Host "Workflow Studio: $demoUrl" -ForegroundColor Green
    Write-Host "API documentation: $demoUrl/docs"
    Write-Host 'Stop with ./stop.ps1. Data is retained in ./data.'
    if (-not $NoBrowser) { Start-Process $demoUrl }
} finally { Pop-Location }
