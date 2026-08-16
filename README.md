# Claude Limit Viewer

A GNOME Shell extension that shows your Claude Code **5-hour session** and
**7-day (weekly)** usage limits in the top panel.

![status](https://img.shields.io/badge/GNOME%20Shell-45--50-blue)

## What it looks like

- **In the panel:** compact text like `5h 12% · 7d 42%`, colored green →
  orange → red at the 70% / 90% thresholds.
- **Click → dropdown:** one row per limit the API reports — current session,
  all-model weekly, and any per-model weekly caps your plan has (e.g. Opus,
  Sonnet) — each with a progress bar, percentage, and time-to-reset. The
  limit currently throttling you is marked *in use*.
- **Refresh now** button in the dropdown, and it re-checks automatically
  every 60 seconds and whenever you open the dropdown.

## How it gets the data

Claude Code (the `claude` CLI) stores an OAuth session at
`~/.claude/.credentials.json` after you log in. This extension reads the
`accessToken` from that file and calls the same endpoint Claude Code's own
`/usage` command uses:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
```

No credentials are entered into the extension and nothing is sent anywhere
except that one Anthropic endpoint.

**Token expiry:** Claude Code keeps that token fresh as long as you use it
normally. If it's been idle long enough to expire, the request 401s and the
panel shows **"Sign in"** — run `claude` (or otherwise use Claude Code) once
to refresh it, then the extension picks it back up on its next poll.
Standalone OAuth refresh is intentionally not implemented, matching the
minimal-surface approach of the reference widgets this was modeled on.

If your Claude config lives somewhere other than `~/.claude`, set
`CLAUDE_CONFIG_DIR` in your session environment and the extension will read
`$CLAUDE_CONFIG_DIR/.credentials.json` instead.

## Requirements

- GNOME Shell 45–50 (uses the modern ESM extension API)
- [Claude Code](https://claude.com/claude-code) CLI installed and logged in
  at least once, so `~/.claude/.credentials.json` exists
- libsoup3 (ships with GNOME Shell already)

## Install

```sh
git clone https://github.com/kevinRForshey/GnomeShellClaudeMeter.git
cd GnomeShellClaudeMeter
git checkout main   # stable; the default branch (development) is where active work happens
./install.sh
```

This symlinks `claude-limit-viewer@kevinf/` into
`~/.local/share/gnome-shell/extensions/claude-limit-viewer@kevinf`, so
editing the source here edits the live extension, and enables it via
`gnome-extensions enable`.

- **First install only:** GNOME Shell has to discover the new extension
  directory. On X11, `Alt+F2` → type `r` → `Enter` reloads the shell in
  place. On **Wayland**, the shell process can't be reloaded live — log out
  and back in once.
- **After editing `extension.js`:** GJS caches the ES module, so a plain
  disable/enable doesn't always pick up code changes:

  ```sh
  gnome-extensions disable claude-limit-viewer@kevinf
  gnome-extensions enable claude-limit-viewer@kevinf
  ```

  If that doesn't show your changes, log out/in (Wayland) or reload the
  shell (X11) again.

To verify it's recognized:

```sh
gnome-extensions list | grep claude-limit-viewer
gnome-extensions info claude-limit-viewer@kevinf
```

## Uninstall

```sh
gnome-extensions disable claude-limit-viewer@kevinf
rm ~/.local/share/gnome-shell/extensions/claude-limit-viewer@kevinf
```

(It's a symlink to this repo, so `rm` — not `rm -rf` — is correct and won't
touch the source here.)

## Layout

```
claude-limit-viewer@kevinf/
  metadata.json      # uuid, name, supported shell versions
  extension.js        # panel indicator, popup menu, polling, API calls
  stylesheet.css       # panel/menu styling, severity colors, bar styling
install.sh              # dev install: symlink + enable
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Panel shows "Sign in" | No `~/.claude/.credentials.json`, or it has no `accessToken` — run `claude` to log in |
| Panel shows "Sign in" after working before | Access token expired from inactivity — run `claude` once to refresh it |
| Panel shows "Error" | Network issue or non-200/401/403 response from `api.anthropic.com`; open the dropdown for the exact HTTP status |
| Extension doesn't appear after `install.sh` | First-time discovery needs a shell reload (X11: `Alt+F2` `r`) or logout/login (Wayland) |
| Code edits don't show up | Disable/enable the extension again, or reload/logout as above — GJS caches the module |

## Privacy

The only network call this extension makes is the single `GET` above to
`api.anthropic.com`, authenticated with the token Claude Code already
created. No telemetry, no third-party services, no data leaves your machine
except that request.
