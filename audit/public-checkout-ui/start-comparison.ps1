$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$oldRoot = Join-Path $HOME ".config\superpowers\worktrees\Register\checkout-before-ui-audit"
$logRoot = Join-Path $PSScriptRoot "comparison-logs"

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

if (-not (Test-Path $oldRoot)) {
  throw "Old-version worktree not found at $oldRoot"
}

$ports = 4173, 4184, 5173, 5184
$busy = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in $ports }

if ($busy) {
  $details = $busy | ForEach-Object { "$($_.LocalPort) (PID $($_.OwningProcess))" }
  throw "Comparison ports are already in use: $($details -join ', ')"
}

function Start-HiddenProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$LogName,
    [hashtable]$Environment = @{}
  )

  $previous = @{}
  foreach ($key in $Environment.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $Environment[$key], "Process")
  }

  try {
    Start-Process `
      -FilePath $FilePath `
      -ArgumentList $ArgumentList `
      -WorkingDirectory $WorkingDirectory `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logRoot "$LogName.out.log") `
      -RedirectStandardError (Join-Path $logRoot "$LogName.err.log")
  } finally {
    foreach ($key in $Environment.Keys) {
      [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
    }
  }
}

Start-HiddenProcess `
  -FilePath "pnpm.cmd" `
  -ArgumentList @(
    "--filter",
    "@workspace/checkout",
    "exec",
    "vite",
    "--config",
    "vite.config.ts",
    "--host",
    "0.0.0.0",
    "--port",
    "5173",
    "--strictPort"
  ) `
  -WorkingDirectory $projectRoot `
  -LogName "new-vite"

Start-HiddenProcess `
  -FilePath "node.exe" `
  -ArgumentList @((Join-Path $PSScriptRoot "mock-server.cjs")) `
  -WorkingDirectory $projectRoot `
  -LogName "new-mock" `
  -Environment @{
    MOCK_PORT = "4173"
    VITE_PORT = "5173"
    PUBLIC_ORIGIN = "http://127.0.0.1:4173"
  }

Start-HiddenProcess `
  -FilePath "pnpm.cmd" `
  -ArgumentList @(
    "--filter",
    "@workspace/checkout",
    "exec",
    "vite",
    "--config",
    "vite.config.ts",
    "--host",
    "0.0.0.0",
    "--port",
    "5184",
    "--strictPort"
  ) `
  -WorkingDirectory $oldRoot `
  -LogName "old-vite"

Start-HiddenProcess `
  -FilePath "node.exe" `
  -ArgumentList @((Join-Path $PSScriptRoot "mock-server.cjs")) `
  -WorkingDirectory $projectRoot `
  -LogName "old-mock" `
  -Environment @{
    MOCK_PORT = "4184"
    VITE_PORT = "5184"
    PUBLIC_ORIGIN = "http://127.0.0.1:4184"
  }

Start-Sleep -Seconds 2

$listeners = Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in $ports } |
  Sort-Object LocalPort

if ($listeners.Count -ne 4) {
  throw "One or more comparison servers did not start. Check $logRoot"
}

Write-Output "New checkout: http://127.0.0.1:4173"
Write-Output "Old checkout: http://127.0.0.1:4184"
