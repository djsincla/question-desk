# Installs (or updates) the Question Desk QR add-in for PowerPoint on this PC, for you only.
# Double-click "Install Question Desk QR.cmd" from the Windows download, which runs this.
#
# It saves the add-in's manifest in %LOCALAPPDATA%\QuestionDeskQR and registers it the way
# Microsoft's own add-in tools do (HKCU\Software\Microsoft\Office\16.0\Wef\Developer).
# Nothing is installed for other users and no administrator rights are needed.
$ErrorActionPreference = 'Stop'

$ManifestUrl = if ($env:QD_MANIFEST_URL) { $env:QD_MANIFEST_URL } else { 'https://djsincla.github.io/question-desk/addin/manifest.xml' }
$AddinId = 'cbe57d61-2cd8-4fdf-ae94-438fc403a58e'
$Folder = Join-Path $env:LOCALAPPDATA 'QuestionDeskQR'
$Manifest = Join-Path $Folder 'manifest.xml'
$Key = 'HKCU:\Software\Microsoft\Office\16.0\Wef\Developer'

Write-Host 'Installing Question Desk QR for PowerPoint...'
try {
  New-Item -ItemType Directory -Force -Path $Folder | Out-Null
  $download = "$Manifest.download"
  if ($ManifestUrl -like 'file:*') {
    Copy-Item -Force -Path ([Uri]$ManifestUrl).LocalPath -Destination $download
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $ManifestUrl -OutFile $download
  }
  if (-not (Select-String -Path $download -SimpleMatch $AddinId -Quiet)) {
    Remove-Item -Force $download
    throw 'The downloaded file is not the Question Desk QR add-in. Nothing was changed.'
  }
  Move-Item -Force -Path $download -Destination $Manifest

  if (-not (Test-Path $Key)) { New-Item -Path $Key -Force | Out-Null }
  New-ItemProperty -Path $Key -Name $AddinId -Value $Manifest -PropertyType String -Force | Out-Null

  $version = ([xml](Get-Content -Raw $Manifest)).OfficeApp.Version
  Write-Host "Installed Question Desk QR $version." -ForegroundColor Green
  if (Get-Process -Name POWERPNT -ErrorAction SilentlyContinue) {
    Write-Host 'PowerPoint is open: close it and open it again.'
  }
  Write-Host 'In PowerPoint, open a presentation, then Home > Add-ins (or Insert > My Add-ins) > Question Desk QR.'
} catch {
  Write-Host ('Could not install: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
