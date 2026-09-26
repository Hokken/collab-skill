# Install the Collab skill from this repo (Windows).
# Safe to re-run. Folders are junctions to this repo, so `git pull` updates the skill in place.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -LinkCodexSkills   # also link into ~\.codex\skills
param(
  [switch]$LinkCodexSkills,   # only needed if Codex does not list Collab from ~\.agents\skills
  [switch]$Yes                # add ~\.local\bin to the user PATH without asking
)
$ErrorActionPreference = 'Stop'

$Repo       = $PSScriptRoot
$UserHome   = $env:USERPROFILE
$SkillLink  = Join-Path $UserHome '.agents\skills\Collab'
$ClaudeLink = Join-Path $UserHome '.claude\skills\Collab'
$CodexLink  = Join-Path $UserHome '.codex\skills\Collab'
$Bin        = Join-Path $UserHome '.local\bin'
$CollabHome = if ($env:COLLAB_HOME) { $env:COLLAB_HOME } else { Join-Path $UserHome '.collab' }
$Backups    = Join-Path $CollabHome 'backups'   # outside any skills folder, so no duplicate skill
$Js         = Join-Path $Repo 'bin\collab.js'

function Fail($msg) { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js >= 18 is required (winget install OpenJS.NodeJS.LTS)' }
$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 18) { Fail "Node.js >= 18 is required (found $(node --version))" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "warning: git not found - 'collab diff' will not work (winget install Git.Git)" -ForegroundColor Yellow
}

# Set-Junction <target> <path>: make <path> a junction to <target> (no admin or Developer Mode needed).
# A real folder at <path> is moved to the backups folder first.
function Set-Junction([string]$Target, [string]$Path) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($item) {
    if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
      $current = @($item.Target)[0]
      if ($current -and ((Resolve-Path -LiteralPath $current).Path -eq (Resolve-Path -LiteralPath $Target).Path)) {
        Write-Host "ok      $Path"; return
      }
      cmd /c rmdir "$Path" | Out-Null   # removes the link only, never the target's contents
    } else {
      New-Item -ItemType Directory -Force -Path $Backups | Out-Null
      $backup = Join-Path $Backups ('{0}.{1}' -f $item.Name, (Get-Date -Format 'yyyyMMdd-HHmmss'))
      Move-Item -LiteralPath $Path -Destination $backup
      Write-Host "backup  $Path -> $backup"
    }
  }
  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
  Write-Host "linked  $Path -> $Target"
}

Set-Junction $Repo $SkillLink
Set-Junction $Repo $ClaudeLink
if ($LinkCodexSkills) { Set-Junction $Repo $CodexLink }

# `collab` on PATH: a .cmd shim for PowerShell/cmd and an extensionless sh shim for Git Bash.
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
[IO.File]::WriteAllText((Join-Path $Bin 'collab.cmd'), "@node `"$Js`" %*`r`n")
[IO.File]::WriteAllText((Join-Path $Bin 'collab'), '#!/bin/sh' + "`n" + 'exec node "$HOME/.agents/skills/Collab/bin/collab.js" "$@"' + "`n")
Write-Host "shims   $Bin\collab.cmd, $Bin\collab"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (-not (($userPath -split ';') -contains $Bin)) {
  Write-Host ""
  Write-Host "$Bin is not on your user PATH."
  $answer = if ($Yes) { 'y' } else { Read-Host 'Add it now? [y/N]' }
  if ($answer -match '^(y|yes)$') {
    $newPath = (($userPath.TrimEnd(';'), $Bin) | Where-Object { $_ }) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host 'added - restart VS Code and open new terminals for it to take effect'
  } else {
    Write-Host "skipped - until then, run: node `"$Js`" help"
  }
}

Write-Host ""
Write-Host "Done. In a NEW terminal check with: collab help"
Write-Host "Restart Claude Code / Codex sessions so they load the skill."
Write-Host "If Codex's /skills does not list Collab, re-run with -LinkCodexSkills."
