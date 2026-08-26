# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
