# Clavis team

A Buzz 1.0 plugin that adapts Buzz to Clavis.

- **Workspaces for everyone:** everyone gets the same team workspaces (same names, icons, order), and every channel with a team prefix always goes into its team workspace. Your own workspace with the same name as a team workspace is removed, so there are no doubles; own workspaces with other names stay. The layout lives in the canvas of #00_begin_hier; without a list there, the built-in list (`DEFAULT_SECTIONS` in `plugin.js`) is used. New channels (for example for a new colleague) are filed right away.
- **Tags:** `@studio`, `@redactie`, … mention everyone in that department.
- **Clavis profile:** title, departments, birthday, office or home per weekday, a favourite book, a fun fact … It shows up in the profile panel. Fill it in under *Settings → Clavis profile*.
- **Unread counters:** a red counter with the number of unread messages (99+ above 99) on every channel and DM in the sidebar, instead of a white, bold row. Muted channels only count mentions.
- **Polls:** open or anonymous, with one or more choices and an optional closing time. Open polls show the voters' profile photos. Anonymous votes are counted by the "Clavis Polls" bot on cladocker01.

## Install

Buzz 1.0 → **Settings → Manage plugins → Add**, then choose this repository (Git) or the folder (**Browse**).

## Files

| File | What |
|---|---|
| `manifest.json` | Plugin ID `clavis.team-sections` |
| `plugin.js` | All the code. Each feature runs in isolation, with its own status on the plugin page. |
| `icon.png` | The Clavis logo |
| `canvas-00_begin_hier.md` | Starter text for the canvas of #00_begin_hier |

## Changes

`main` is protected: every change goes through a pull request with a review from the `codeowners` team.

Full documentation lives in the Obsidian vault *Clavis Memory*, note "2026-11-19 Buzz-plugin Clavis team".
