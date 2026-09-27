# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Idle SSH tabs no longer drop to "Reconnecting…" every 5 minutes. The wedge
  watchdog treated a silent prompt as a dead link (keepalive replies never
  reach the terminal); it now sends an SSH-level ping first and only
  reconnects when the ping goes unanswered, so busy devices (a long Junos
  `commit`, `write memory`) are no longer cut off either. Its forced
  disconnect is also time-bounded.
- A first SSH connect is bounded (60s), so a device that never finishes the
  login can't leave a tab stuck on "connecting" with no way to retry.
- New sessions open at the terminal's real size instead of 80x24 (devices
  paged every 24 lines and wrapped at 80 columns until the window was
  resized) — SSH, telnet and local shells.
- Several sessions at once: parked "waiting for vault unlock" connects are
  queued instead of overwriting each other (which stranded tabs on
  "connecting"); password prompts queue instead of swapping hosts mid-typing;
  one tab's failed login no longer tears down another tab's successful one;
  Quick Connect no longer shows "Connecting…" for the next session while a
  slow one is still connecting.
- SSH no longer sends a guaranteed-to-fail empty-password login before asking
  for the password (each counted toward TACACS/RADIUS lockout).
- Unreachable hosts, host-key mismatches, timeouts and telnet errors now show
  the real error instead of opening the password dialog.
- Copy: selecting text in a panel (AI chat, API responses) and pressing
  Ctrl/Cmd+C copies it again instead of sending ^C to the device; clicking an
  IP / MAC / interface no longer silently replaces the clipboard (smart links
  now copy on Ctrl/Cmd+click); copy-on-select also works when the drag ends
  outside the terminal.
- macOS terminal copy: Option+drag now selects text even when a full-screen
  app (vim, tmux, htop, omp, claude) has mouse mode on — before, Mac had no
  way to select there (Windows could Shift+drag). Cmd/Ctrl+C no longer lets
  the webview's own copy race ours and sometimes paste the word from the last
  right-click.
- Reconnect is easy to find: a dropped session shows a "Disconnected — press
  Enter or Reconnect" bar, pressing Enter in it reconnects, and the tab's
  reconnect button is always visible instead of hover-only.
- "Reset all settings" moved out of the Settings header (next to the close X,
  easy to hit by mistake) to the bottom of Settings → Backup, with a clear
  description of what it clears.
- Pop-out windows no longer freeze the app on Windows.
- Serial writes no longer block a runtime worker until every byte has left the
  port (pastes at 9600 baud stalled echo and other sessions).
- The "error" / "warning" search chips work (they used an invalid regex); the
  SFTP browser follows the active session; the AI assistant targets the active
  device instead of silently falling back to another one; the REC indicator
  can't show the previous tab's state.

## [1.4.2] - 2026-08-26

### Added

- Per-server HTTP headers for authenticated MCP endpoints.

### Fixed

- Direct SSH continuously drains the primary `russh` channel, preventing the
  session loop from freezing after more than 100 discrete terminal messages.
- SSH disconnect closes the channel before the transport and reconnects use a
  bounded handshake, so remote shells and `omp` processes are reaped cleanly.
- Saved SSH passwords survive app restarts: after the vault master password is
  entered, connection retry reads the backend's live vault state and retrieves
  the stored device password instead of reopening the save-password dialog.
- Terminal focus and the echo watchdog keep full-screen TUI input responsive
  and recover genuinely silent SSH sessions.

## [1.4.1] - 2026-08-25

### Fixed

- xterm helper-textarea focus is restored after a full-screen TUI (`omp`) so
  typing / Esc / Ctrl+C reach the PTY again (#31).

## [1.4.0] - 2026-08-25

### Security

- SSH client upgraded from `russh`/`russh-keys` **0.43.0** to `russh` **0.63.1**
  (CVE-2024-43410 and ~19 subsequent releases). `russh-keys` is folded into
  `russh::keys`. Crypto backend is `ring` (not `aws-lc-rs`) so Windows MSVC
  and ubuntu-22.04 CI do not need NASM. MSRV is now **1.85** (russh 0.63
  requirement). TOFU fingerprint format, `NewAlgorithm` accept+warn, and
  `Zeroizing` private keys are unchanged.
- Device TLS verification (`verifyDeviceTls`) now defaults to **on** for new
  installs; the Settings toggle carries a warning that credentials can be
  intercepted on untrusted networks while verification is disabled.
- SSH known-hosts verification now warns when a known host offers a host-key
  algorithm that was not seen at trust-on-first-use time, and the
  no-prior-key verification branch fails closed instead of silently
  accepting (`KeyVerifyResult` enum in `ssh/known_hosts.rs`).
- Auto-reconnect now classifies failures: authentication errors no longer
  trigger reconnect loops that can lock accounts or spam devices.
- SSH private keys are held in `Zeroizing` memory so key material is wiped
  on drop instead of lingering in freed heap.
- Session log files are created with `0600` permissions instead of the
  umask default.
- `ai_cli` shell-out paths are guarded by a blocklist of dangerous shell
  metacharacters/commands.
- Webhook URLs are restricted to `https:` scheme.
- `mcp_servers.json` is written atomically (temp file + rename) so a crash
  mid-write can no longer corrupt the server registry.
- `ai_chat_stream` events carry a `stream_id` so the frontend can ignore
  stale deltas from abandoned streams; streams can be cancelled via the new
  `ai_cancel_stream` command.
- MSRV pinned to 1.85 in `Cargo.toml` (`rust-version`) so dependency
  resolution cannot silently require a newer toolchain than CI verifies
  (was 1.77.2; russh 0.63 requires 1.85).

### Fixed

- Connect payload construction is unified in `utils/connect.ts`
  (`buildConnectPayload`): the auth-dialog retry path no longer drops serial
  line settings (data bits / parity / stop bits) or local-shell launch
  details (command / args / cwd).
- Per-host startup commands now also run after a successful auth-dialog
  retry — previously they only ran on the direct-connect path.
- Global keyboard shortcuts are attached once (not re-attached per render)
  and plain-Ctrl chords (Ctrl+K/T/F/B) no longer fire app overlays while
  focus is in the terminal or an input, so they reach the shell as
  readline/emacs keys; Ctrl+W no longer closes a live session behind an
  open overlay or disconnects popped-out sessions.
- Config Editor: `commit` removed from the dangerous-commands warning list —
  it is the *required* apply step on Junos, so flagging it trained users to
  ignore the warning entirely.
- Vault secret persistence: identity fields (base URL / client id / host /
  username) are now persistence dependencies, so editing an endpoint without
  retyping the secret no longer leaves a stale identity that silently
  deleted the secret on next launch.
- Aruba Central and Juniper Mist credential pushes to the backend are
  debounced — no more per-keystroke IPC with intermediate secrets.
- Workspace persistence to localStorage is debounced (500 ms) instead of
  serializing all sessions on every status update.
- Pending debounced secret persists are flushed on window close/reload, so
  secrets typed within the debounce window are no longer lost.
- Settings panel API keys are flushed when the panel closes, not only on
  the debounce timer.

### Performance

- AI Assistant: switched from the full Prism bundle to `PrismLight` with
  per-language registration, memoized message bubbles, and
  rAF-coalesced streaming deltas — long chats no longer re-render every
  token.
- App shell: per-session terminals are memoized with stable `onSend`
  handlers, store subscriptions use narrow per-field selectors, and the
  Config Editor / AI Assistant panels stay mounted (CSS-hidden) so editor
  buffers and chat history survive panel toggling.

### Added

- Settings left nav (Appearance · Terminal · AI + MCP · Cloud · Backup), Tools
  menu entries for SFTP / Bulk runner / Config archive / MCP, empty-state MCP
  line, and first-run Help (#28).
- Unit tests for the connect-payload builder, AI gating rules, terminal
  utilities, and the syntax highlighter (vitest, 43 tests).
- Accessibility: `aria-label`s on icon-only buttons across the app, and
  `role="switch"` / `aria-checked` on the TLS verification toggle.
- Config Editor send is cancellable with "sent k of n" progress reporting.
- A Keep-a-Changelog CHANGELOG.md (this file).
- (Drafted, pending `workflow` scope on the token) CI advisory `npm audit`
  and `cargo audit` steps.

### Changed

- `ConnectResponse` carries an optional `warning` field so backend warnings
  (e.g. host-key algorithm changes) surface in the UI instead of being
  dropped; local/serial/telnet connect paths populate it with `None`.
- Aruba Central client state is behind a `Mutex` so concurrent credential
  pushes cannot interleave a half-configured client.

### Removed

- `thiserror` dependency (error enums now implement `Display`/`Error` by
  hand).
- `sha2` dependency (no remaining call sites).
