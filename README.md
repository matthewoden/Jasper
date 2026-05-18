# Jasper

A lightweight, self-hosted, browser-based markdown notes app. Local files,
no plugins, no cloud — built for self-hosting on Mac or WSL2.

## Why Jasper

Writing, searching, and organizing markdown notes in the browser should
feel as fluid as a native note-taking app — with zero plugin attack
surface and full local ownership of the underlying files. Jasper runs
on your machine, binds to loopback by default, and stores every note as
a plain `.md` file you can read with any editor.

## Quick Start (macOS)

1. Download `jasper` from the project releases page (ask the project
   owner for the link or grab the binary directly from a coworker).
2. **First time only** — macOS will block the unsigned binary:
   - Right-click `jasper` in Finder
   - Choose "Open" from the menu
   - In the dialog, click "Open" again
   - macOS will remember the choice; subsequent launches don't prompt.
3. Move `jasper` somewhere on your PATH (e.g., `/usr/local/bin`).
4. Run:
   ```
   jasper install
   ```
5. Open <http://127.0.0.1:6683/> in your browser. The first-run wizard
   prompts for your data directory and theme; submit and start writing.

> **Why the Gatekeeper warning:** Jasper isn't yet code-signed (deferred for
> the small-circle distribution model). When distribution broadens we'll
> ship a notarized build.

## Quick Start (WSL2)

1. Make sure systemd is enabled in your WSL distro:
   ```
   # In your distro's /etc/wsl.conf (create the file if missing):
   [boot]
   systemd=true
   ```
   Then from a Windows admin prompt: `wsl --shutdown`. Restart your distro.

2. Download `jasper` and put it on your PATH:
   ```
   curl -L -o ~/.local/bin/jasper <release-url-for-jasper-linux>
   chmod +x ~/.local/bin/jasper
   ```

3. Install + start:
   ```
   jasper install
   ```
   This enables linger (so Jasper runs without an open terminal) and
   starts the systemd user unit.

4. From the Windows host or inside WSL: open <http://127.0.0.1:6683/>.

## First-Run Wizard

On first browser hit, Jasper redirects to `/setup`:

- **Data directory** — where your `.md` files live. Pick an empty folder
  you already own. Jasper validates the path (rejects paths with non-ASCII,
  paths inside existing Jasper vaults, paths the server can't write to).
- **Theme** — dark (default) or light. The wizard previews the change live.
- **AI access (MCP)** — optional. When enabled, lets local AI tools
  (Claude Desktop, Cursor, etc.) read your notes and write to folders
  you explicitly grant. Off by default.
- **Daily notes** — customize the template; optionally create today's
  note immediately.

Click "Start Jasper" and the SPA loads.

## Where Things Live

Inside your data directory:

- `notes/` — your `.md` files. **This is the source of truth.** Back this
  up and you've backed up Jasper.
- `storage/` — SQLite index + config.json. **Regenerable from `notes/`** —
  delete this folder anytime and Jasper will rebuild on next start.
- `logs/` — `jasper.log` with daily rotation (`jasper-YYYY-MM-DD.log` for
  previous days). Surfaced by `jasper status` and `jasper doctor`.

## Backup

Just copy your data directory somewhere safe. The whole directory is
plain files. Restoring is a copy-back.

## Subcommands

| Subcommand | What it does |
|---|---|
| `jasper serve`     | Start the HTTP + WebSocket server (run by the service) |
| `jasper install`   | Register Jasper as a launchd LaunchAgent or systemd user unit |
| `jasper uninstall` | Unregister the service (your notes are untouched) |
| `jasper status`    | Show service state, address, data dir, log path, MCP state |
| `jasper doctor`    | Diagnose install/runtime issues with plain-English fixes |
| `jasper doctor --json` | Same checks, JSON output for support tooling |
| `jasper version`   | Print binary version + commit |

Each subcommand has a hand-tuned `--help` that explains what it does and any
side effects.

## Integrations

### Claude Desktop (MCP)

1. In Jasper's first-run wizard (or in `~/.jasper/storage/config.json`),
   enable MCP:
   ```json
   {
     "mcp": { "enabled": true, "port": 6684, "bind": "127.0.0.1" }
   }
   ```
   Restart Jasper (`jasper uninstall && jasper install` if it's
   service-running).

2. In Claude Desktop's `claude_desktop_config.json`, add:
   ```json
   {
     "mcpServers": {
       "jasper": {
         "transport": "streamable-http",
         "url": "http://127.0.0.1:6684/mcp"
       }
     }
   }
   ```

3. Restart Claude Desktop. The Jasper MCP server exposes read tools
   globally (list_notes, read_note, search_notes, read_attachment).

4. To grant write access on a folder: right-click the folder in the
   Jasper sidebar → **Grant AI access ▸** → choose **Edit only**
   (create + update) or **Full** (create + update + move + delete).
   The folder gets a small sparkles icon to show active grants.

5. Revoke anytime: same right-click menu → **Revoke access**.

### Cursor (MCP)

Cursor follows the same MCP config shape — see Cursor's docs for the
config file path, then paste the same `mcpServers` block.

## Troubleshooting

Run `jasper doctor` first. It checks:

- WSL2 `systemd=true` (fix: edit `/etc/wsl.conf`, then `wsl --shutdown`)
- `loginctl enable-linger` (fix: `loginctl enable-linger $USER` — or rerun `jasper install`)
- Port 6683 availability (fix: edit `server.port` in `config.json` then restart)
- Port 6684 availability if MCP is enabled (fix: edit `mcp.port`)
- Data directory permissions
- Migration state (any pending migrations show a fix command)
- Log file is writable
- Frontend bundle is embedded in the binary

For machine-readable output: `jasper doctor --json`.

### Uninstall + reinstall

```
jasper uninstall
# Optionally delete the data dir to start fresh (your notes will be lost):
# rm -rf ~/.jasper
jasper install
```

`jasper uninstall` is idempotent; safe to run even if not installed.

## Changelog

- **0.x — Phase 8:** Native install (launchd / systemd), first-run wizard,
  Reveal in file manager, deep links, MCP server with folder-scoped ACL,
  port migration to 6683, perf + security validation.
- **0.x — Phase 7:** Search, daily notes, attachments, command palette, switcher.
- **0.x — Phase 6:** Tags, backlinks, wiki-links + chrome polish.
- **0.x — Phase 5:** CodeMirror 6 editor with live markdown rendering.
- **0.x — Phase 4:** WebSocket session sync.
- **0.x — Phase 3:** File tree + folder CRUD.
- **0.x — Phase 2:** SQLite index + migrations.
- **0.x — Phase 1:** Vertical slice — Hello Note.

## License

MIT. See [LICENSE](LICENSE) (to be added).
