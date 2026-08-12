$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'"
$zombies = $procs | Where-Object { $_.CommandLine -match 'out\\main\\daemon\.js' -and $_.CommandLine -match '--userData' }
foreach ($p in $zombies) {
  Write-Output ("killed " + $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Output ("remaining electron: " + (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Measure-Object).Count)
