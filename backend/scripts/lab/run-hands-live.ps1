<#
.SYNOPSIS
  Runs the live check of the act hands (scripts/minecraft-hands-live-probe.ts) on the VM with THIS worktree's body code, in one command.

.DESCRIPTION
  Packs backend/src + backend/scripts (+ the two package files) of the worktree this script lives in, sends the tar and
  scripts/lab/run-hands-live.sh to the VM, and runs it there: an isolated flat-world server, the probe through the production
  body (NativeCommonFcaBody.execute for the skill act), the table, and a full clean-up (server, world, tmux, code directory).
  No model and no paid key is reachable; the production services and their env files are not touched. One run at a time.

  Windows PowerShell 5.1 drops double quotes in arguments to ssh, so nothing here passes one: the VM side takes KEY=VALUE words.
  If scripts are blocked:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\lab\run-hands-live.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File backend\scripts\lab\run-hands-live.ps1
  ... -Scenes place_table,go_dig_wall          only those scenes (names or prefixes)
  ... -GoFrom a9b7d18                          swap go.ts for the one of that commit (does the check catch the old bug?)
  ... -Label after-rel57                       the label of the run (default: the time)
#>
param(
  [string]$Label = (Get-Date -Format 'yyyyMMdd-HHmmss'),
  [string]$Scenes = '',
  [string]$GoFrom = '',
  [int]$SceneSeconds = 0,
  [int]$Repeat = 0,
  [int]$TimeoutSeconds = 1500,
  [string]$OutDir = '',
  [string]$VmHost = 'azure-constant-server',
  [switch]$KeepRemote,
  [switch]$KeepLab
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$labDir = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $labDir '..\..\..')).Path
$git = if (Test-Path 'C:\Shannon\tools\git\cmd\git.exe') { 'C:\Shannon\tools\git\cmd\git.exe' } else { 'git' }
if (-not (Test-Path (Join-Path $repo 'backend\src\services\minebot'))) { throw "not a Shannon worktree: $repo" }
if ($Label -notmatch '^[A-Za-z0-9._-]{1,40}$') { throw 'Label: letters, digits, . _ - only (40 at most)' }
if ($Scenes -notmatch '^[A-Za-z0-9_,]*$') { throw 'Scenes: names separated by commas' }
if (-not $OutDir) { $OutDir = Join-Path $env:TEMP "minebot-hands-live\$Label" }
$work = Join-Path $env:TEMP "minebot-hands-live-work-$Label"
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force $work | Out-Null
New-Item -ItemType Directory -Force $OutDir | Out-Null

# 1. the code of this worktree (tracked or not: what is on disk is what runs)
$head = (& $git -C $repo rev-parse --short HEAD).Trim()
$dirty = (& $git -C $repo status --short -- backend/src backend/scripts | Measure-Object).Count
Write-Host "worktree $repo at $head ($dirty uncommitted paths under backend/src and backend/scripts)"
$tar = Join-Path $work 'code.tar'
& tar.exe -cf $tar --exclude='*.test.ts' --exclude='node_modules' -C $repo backend/src backend/scripts backend/package.json backend/tsconfig.json package.json
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
$overlayArg = ''
if ($GoFrom) {
  $relative = 'backend/src/services/minebot/utils/primitives/go.ts'
  $root = Join-Path $work 'overlay'
  New-Item -ItemType Directory -Force (Join-Path $root (Split-Path $relative -Parent)) | Out-Null
  $text = & $git -C $repo show "${GoFrom}:$relative"
  if ($LASTEXITCODE -ne 0) { throw "git show ${GoFrom}:$relative failed" }
  [IO.File]::WriteAllText((Join-Path $root $relative), (($text -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
  & tar.exe -cf (Join-Path $work 'overlay.tar') -C $root $relative
  if ($LASTEXITCODE -ne 0) { throw 'overlay tar failed' }
  $overlayArg = 'HANDS_OVERLAY=/home/azureuser/.cache/minebot-lab/hands-in/overlay.tar'
  Write-Host "go.ts is swapped for the one of $GoFrom (a comparison run, not the worktree's code)"
}

# 2. the VM-side script with LF line endings (a CRLF script does not run on the VM)
$sh = Join-Path $work 'run-hands-live.sh'
$content = [IO.File]::ReadAllText((Join-Path $labDir 'run-hands-live.sh')) -replace "`r`n", "`n"
[IO.File]::WriteAllText($sh, $content, (New-Object Text.UTF8Encoding $false))

# 3. send and run
$inbox = '.cache/minebot-lab/hands-in'
& ssh -o BatchMode=yes $VmHost "mkdir -p $inbox"
if ($LASTEXITCODE -ne 0) { throw 'ssh failed' }
$files = @($tar, $sh); if ($GoFrom) { $files += (Join-Path $work 'overlay.tar') }
& scp -o BatchMode=yes @files "${VmHost}:$inbox/"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
$words = @("HANDS_TIMEOUT=$TimeoutSeconds")
if ($Scenes) { $words += "HANDS_SCENES=$Scenes" }
if ($SceneSeconds -gt 0) { $words += "HANDS_SCENE_SECONDS=$SceneSeconds" }
if ($Repeat -gt 1) { $words += "HANDS_REPEAT=$Repeat" }
if ($overlayArg) { $words += $overlayArg }
if ($KeepLab) { $words += 'HANDS_KEEP=1' }
$remote = "bash /home/azureuser/$inbox/run-hands-live.sh $Label /home/azureuser/$inbox/code.tar " + ($words -join ' ')
Write-Host "ssh $VmHost $remote"
& ssh -o BatchMode=yes $VmHost $remote
$status = $LASTEXITCODE

# 4. bring the logs back, then remove what this run left on the VM
$remoteOut = "/home/azureuser/.cache/minebot-lab/hands-$Label"
& scp -o BatchMode=yes -r "${VmHost}:$remoteOut/*" $OutDir 2>$null
$fetched = ($LASTEXITCODE -eq 0)
Write-Host "logs: $OutDir (report.json, probe.log, server-latest.log, server-notable.txt)"
if ($fetched -and -not $KeepRemote) {
  & ssh -o BatchMode=yes $VmHost "rm -rf $remoteOut $inbox" | Out-Null
  Write-Host 'the VM copies of the logs and the uploaded tars are removed'
} elseif (-not $fetched) { Write-Warning "could not fetch the logs: they stay on the VM in $remoteOut" }
Remove-Item -Recurse -Force $work
exit $status
