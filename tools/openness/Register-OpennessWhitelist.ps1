# SPDX-License-Identifier: MIT
<#
.SYNOPSIS
  Adds executables to the TIA Portal Openness whitelist, so TIA Portal does not ask "Openness access: Yes / Yes to all".
.DESCRIPTION
  TIA Portal remembers an allowed Openness client by file name + SHA-256 (base64) + UTC write time under
  HKLM\SOFTWARE\Siemens\Automation\Openness\<version>\Whitelist\<exe>\Entry (V21 and later: ...\Openness\AllowList\<exe>\Entry).
  The hash changes with every build,
  so developer builds would prompt again. The bridge and spike builds call this script after each build.

  Writing under HKLM needs rights: run once, elevated, with -GrantUser to let that user maintain the whitelist.
  Note this weakens the Openness firewall for that user (any program of theirs can whitelist itself); use it on
  development machines only.
.EXAMPLE
  # once, from an elevated PowerShell
  powershell -ExecutionPolicy Bypass -File tools\openness\Register-OpennessWhitelist.ps1 -GrantUser $env:USERNAME
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\openness\Register-OpennessWhitelist.ps1 -Path bridge\...\rung-bridge-v20.exe
#>
[CmdletBinding()]
param(
    [string[]]$Path = @(),
    [string]$Version = '20.0',
    [string]$GrantUser,
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
# V21 and later keep one AllowList for every version and do not read <version>\Whitelist
$root = if ([int]($Version.Split('.')[0]) -ge 21) { "HKLM:\SOFTWARE\Siemens\Automation\Openness\AllowList" } else { "HKLM:\SOFTWARE\Siemens\Automation\Openness\$Version\Whitelist" }

try {
    if ($GrantUser) {
        if (-not (Test-Path $root)) { New-Item -Path $root -Force | Out-Null }
        $acl = Get-Acl $root
        $rule = New-Object Security.AccessControl.RegistryAccessRule($GrantUser, 'FullControl', 'ContainerInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -Path $root -AclObject $acl
        # existing entries were created by TIA Portal (as administrator): extend the grant to them too
        Get-ChildItem $root -Recurse | ForEach-Object { $a = Get-Acl $_.PSPath; $a.AddAccessRule($rule); Set-Acl -Path $_.PSPath -AclObject $a }
        Write-Output "granted $GrantUser write access to $root"
    }
    foreach ($p in $Path) {
        $file = Get-Item -LiteralPath $p
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = [Convert]::ToBase64String($sha.ComputeHash([IO.File]::ReadAllBytes($file.FullName))) } finally { $sha.Dispose() }
        $key = Join-Path (Join-Path $root $file.Name) 'Entry'
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        Set-ItemProperty -Path $key -Name Path -Value $file.FullName
        Set-ItemProperty -Path $key -Name DateModified -Value $file.LastWriteTimeUtc.ToString('yyyy/MM/dd HH:mm:ss.fff', [Globalization.CultureInfo]::InvariantCulture)
        Set-ItemProperty -Path $key -Name FileHash -Value $hash
        if (-not $Quiet) { Write-Output "whitelisted $($file.FullName)" }
    }
}
catch [System.UnauthorizedAccessException], [System.Security.SecurityException] {
    $msg = "Openness whitelist not updated (no write access to $root). Run once elevated: tools\openness\Register-OpennessWhitelist.ps1 -GrantUser <you>"
    if ($Quiet) { Write-Warning $msg; exit 0 } else { throw $msg }
}
