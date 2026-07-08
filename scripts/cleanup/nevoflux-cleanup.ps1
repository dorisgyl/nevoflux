# nevoflux-cleanup.ps1 — Windows post-update cleanup for NevoFlux.
#
# Removes stale add-on caches (and any shadowing agent xpi) from every NevoFlux
# profile so an update never keeps serving the old sidebar bundle, and
# (optionally) refreshes the user skills directory from the skills bundled in
# this install.
#
# Robust by design: a fresh first install has none of these paths — every step
# is best-effort and MUST NOT error when a target is missing.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File nevoflux-cleanup.ps1 [options]
#     -ReplaceSkills   replace user skills with the bundled ones (no prompt)
#     -KeepSkills      never touch skills (no prompt)
#     -NoKill          do not try to close a running NevoFlux/Firefox
#   With no skills flag it prompts interactively; under a non-interactive
#   (installer) session with no flag it defaults to KEEP (never destructive).

[CmdletBinding()]
param(
    [switch]$ReplaceSkills,
    [switch]$KeepSkills,
    [switch]$NoKill
)

# Never abort the whole script on a single failing step; each step guards itself.
$ErrorActionPreference = 'Continue'

function Write-Step($msg) { Write-Host "[nevoflux-cleanup] $msg" }

# --- 1. Make sure the browser is fully closed (files are otherwise locked) ----
if (-not $NoKill) {
    try {
        $procs = Get-Process -Name 'nevoflux', 'firefox' -ErrorAction SilentlyContinue
        if ($procs) {
            Write-Step "Closing running NevoFlux/Firefox ($($procs.Count) process(es))..."
            $procs | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    } catch { }
}

# --- 2. Clean stale add-on caches in every profile --------------------------
# The profile root is build/vendor dependent (MOZ_APP_VENDOR / basename), so
# probe every plausible location instead of hard-coding one.
$profileRoots = @(
    (Join-Path $env:APPDATA 'Mozilla\NevoFlux\Profiles'),
    (Join-Path $env:APPDATA 'NevoFlux Team\NevoFlux\Profiles'),
    (Join-Path $env:APPDATA 'NevoFlux\Profiles')
) | Select-Object -Unique

# Files/dirs to drop per profile. The agent xpi only exists on machines that
# once had a distribution/profile install; the caches exist for everyone.
$profileTargets = @(
    'extensions\agent@nevoflux.com.xpi',
    'extensions\agent@nevoflux.com',
    'addonStartup.json.lz4',
    'startupCache',
    'extensions.json'
)

$cleanedProfiles = 0
foreach ($root in $profileRoots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $p = $_.FullName
        Write-Step "Cleaning profile: $p"
        foreach ($rel in $profileTargets) {
            $target = Join-Path $p $rel
            if (Test-Path -LiteralPath $target) {
                Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        $cleanedProfiles++
    }
}
if ($cleanedProfiles -eq 0) {
    Write-Step "No existing NevoFlux profiles found (fresh install) — nothing to clean."
} else {
    Write-Step "Cleaned add-on caches in $cleanedProfiles profile(s)."
}

# --- 3. Optional: refresh user skills from the bundled defaults --------------
# Bundled defaults ship next to this script: distribution/bin/defaults/skills/
$bundledSkills = Join-Path $PSScriptRoot '..\defaults\skills'
$bundledSkills = [System.IO.Path]::GetFullPath($bundledSkills)
# User skills dir on Windows: %APPDATA%\nevoflux\skills
$userSkills = Join-Path $env:APPDATA 'nevoflux\skills'

function Test-HasEntries($dir) {
    return (Test-Path -LiteralPath $dir) -and
           ((Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
}

if (-not (Test-Path -LiteralPath $bundledSkills)) {
    Write-Step "No bundled skills found next to this script — skipping skills step."
}
elseif (-not (Test-HasEntries $userSkills)) {
    # Fresh / empty — just seed it, no prompt (non-destructive).
    Write-Step "Seeding skills into $userSkills ..."
    New-Item -ItemType Directory -Force -Path $userSkills | Out-Null
    Copy-Item -Path (Join-Path $bundledSkills '*') -Destination $userSkills -Recurse -Force -ErrorAction SilentlyContinue
}
else {
    # Existing skills present — decide whether to replace.
    $doReplace = $false
    if ($ReplaceSkills)      { $doReplace = $true }
    elseif ($KeepSkills)     { $doReplace = $false }
    elseif ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        $ans = Read-Host "Existing skills found at $userSkills. Replace them with the ones bundled in this install? (y/N)"
        $doReplace = ($ans -match '^(y|yes)$')
    }
    else {
        Write-Step "Existing skills kept (non-interactive; pass -ReplaceSkills to overwrite)."
    }

    if ($doReplace) {
        $stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = "$userSkills.bak-$stamp"
        try {
            Write-Step "Backing up existing skills -> $backup"
            Move-Item -LiteralPath $userSkills -Destination $backup -Force -ErrorAction Stop
        } catch {
            Write-Step "Backup failed; clearing in place instead."
            Get-ChildItem -LiteralPath $userSkills -Force -ErrorAction SilentlyContinue |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        }
        New-Item -ItemType Directory -Force -Path $userSkills | Out-Null
        Copy-Item -Path (Join-Path $bundledSkills '*') -Destination $userSkills -Recurse -Force -ErrorAction SilentlyContinue
        Write-Step "Replaced skills from bundled defaults."
    }
}

Write-Step "Done."
exit 0
