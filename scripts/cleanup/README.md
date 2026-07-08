# NevoFlux cleanup scripts

Cross-platform scripts that remove stale add-on caches from every NevoFlux
profile after an update, and can refresh the user skills directory from the
skills bundled in the install. They ship in the browser package under
`distribution/bin/cleanup/` (next to the agent binary and `defaults/skills/`).

| Platform | Script                    |
|----------|---------------------------|
| Windows  | `nevoflux-cleanup.ps1`    |
| Linux    | `nevoflux-cleanup.sh`     |
| macOS    | `nevoflux-cleanup.command`|

## What they do

1. Close a running NevoFlux (skip with `--no-kill` / `-NoKill` — the agent uses
   this so it never kills the live session).
2. For every profile (probing all plausible profile roots), remove stale add-on
   state: `addonStartup.json.lz4`, `startupCache/`, `extensions.json`, and any
   shadowing `agent@nevoflux.com.xpi` copy.
3. Optionally refresh skills from `../defaults/skills`:
   - empty/missing user skills → seed them (non-destructive);
   - existing skills → **prompt** (interactive), or honour `--replace-skills` /
     `--keep-skills`. A replace backs up the old skills to `skills.bak-<stamp>`
     first. Non-interactive with no flag defaults to **keep**.

Every step is best-effort and existence-guarded: on a fresh first install there
is nothing to clean and the scripts exit 0 without error.

## Manual use

The scripts are safest to run with the browser **closed** (some cache files are
locked while it runs). Examples:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File nevoflux-cleanup.ps1
powershell -ExecutionPolicy Bypass -File nevoflux-cleanup.ps1 -ReplaceSkills
```
```bash
# Linux
bash nevoflux-cleanup.sh
bash nevoflux-cleanup.sh --replace-skills
```
```bash
# macOS (or double-click in Finder)
bash nevoflux-cleanup.command
```

## Automatic invocation

The agent runs the platform script (with `--no-kill --keep-skills`) once when it
detects a version bump, so an update never keeps serving an old cached sidebar.
The skills replace/keep choice is surfaced separately so it is never destructive
without consent.
