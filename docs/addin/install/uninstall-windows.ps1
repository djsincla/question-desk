# Removes the Question Desk QR add-in from PowerPoint on this PC.
$ErrorActionPreference = 'Stop'

$AddinId = 'cbe57d61-2cd8-4fdf-ae94-438fc403a58e'
$Folder = Join-Path $env:LOCALAPPDATA 'QuestionDeskQR'
$Key = 'HKCU:\Software\Microsoft\Office\16.0\Wef\Developer'

$removed = $false
if ((Test-Path $Key) -and (Get-ItemProperty -Path $Key -Name $AddinId -ErrorAction SilentlyContinue)) {
  Remove-ItemProperty -Path $Key -Name $AddinId
  $removed = $true
}
if (Test-Path $Folder) {
  Remove-Item -Recurse -Force $Folder
  $removed = $true
}
if ($removed) {
  Write-Host 'Removed Question Desk QR. Close and reopen PowerPoint to finish.' -ForegroundColor Green
} else {
  Write-Host "Question Desk QR wasn't installed for this account."
}
