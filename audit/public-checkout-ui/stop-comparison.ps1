$ports = 4173, 4184, 5173, 5184
$listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in $ports }

$processIds = $listeners.OwningProcess | Sort-Object -Unique
foreach ($processId in $processIds) {
  Stop-Process -Id $processId -ErrorAction SilentlyContinue
}

Write-Output "Stopped checkout comparison servers."
