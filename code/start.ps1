param([int]$Port = 8000, [switch]$Rebuild, [switch]$NoBrowser, [string]$DataDir = '')
$ErrorActionPreference = 'Stop'
$demoRoot = $PSScriptRoot
Push-Location -LiteralPath $demoRoot
try {
    uv sync --frozen --link-mode copy
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
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
    $demoDataRoot = if ($DataDir) {
        if ([IO.Path]::IsPathRooted($DataDir)) { [IO.Path]::GetFullPath($DataDir) }
        else { [IO.Path]::GetFullPath((Join-Path $demoRoot $DataDir)) }
    } else { Join-Path $demoRoot 'data' }
    New-Item -ItemType Directory -Path (Join-Path $demoDataRoot 'logs') -Force | Out-Null
    $previousDataDir = $env:WORKFLOW_DATA_DIR
    try {
        if ($DataDir) { $env:WORKFLOW_DATA_DIR = $demoDataRoot }
        $demoProcess = Start-Process -FilePath (Join-Path $demoRoot '.venv/Scripts/python.exe') -ArgumentList @('-m','uvicorn','backend.main:app','--host','127.0.0.1','--port',"$Port") -WorkingDirectory $demoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $demoDataRoot 'logs/backend.out.log') -RedirectStandardError (Join-Path $demoDataRoot 'logs/backend.err.log') -PassThru
    } finally { $env:WORKFLOW_DATA_DIR = $previousDataDir }
    $demoProcess.Id | Set-Content -LiteralPath (Join-Path $demoDataRoot 'server.pid') -Encoding ascii
    $demoDeadline = (Get-Date).AddSeconds(30)
    $ready = $false
    do {
        Start-Sleep -Milliseconds 300
        try { $response = Invoke-RestMethod "$demoUrl/api/health" -TimeoutSec 1; $ready = $response.service -eq 'workflow-studio' } catch { $ready = $false }
    } until ($ready -or (Get-Date) -gt $demoDeadline)
    if (-not $ready) { throw "Server did not start. See $demoDataRoot/logs/backend.err.log." }
    Write-Host "Workflow Studio: $demoUrl" -ForegroundColor Green
    Write-Host "API documentation: $demoUrl/docs"
    if ($DataDir) { Write-Host "Stop with ./stop.ps1 -DataDir '$demoDataRoot'. Data is retained there." }
    else { Write-Host 'Stop with ./stop.ps1. Persistent storage follows .env or ./data.' }
    if (-not $NoBrowser) { Start-Process $demoUrl }
} finally { Pop-Location }
