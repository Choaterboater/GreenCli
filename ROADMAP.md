# GreenCLI — Roadmap

> One cockpit for **Aruba · Juniper · Mist**.
> (formerly "Aruba Terminal Pro" — rebranded June 2026 to span the full HPE portfolio.)

This file tracks the redesign + hardening effort. It's seeded from a 14-agent
audit that read every subsystem and produced **74 confirmed bugs**, **73 UX
issues**, and **105 missing features**. Items are grouped Done / Next / Backlog.

---

## ✅ Done — Pass 1 (HPE rebrand + premium redesign + correctness)

### Brand & design system
- Rebranded to **GreenCLI** (window title, bundle metadata, in-app brand, `index.html`).
- New design system in `src/styles/index.css`: deep-slate base, **HPE green `#01A982`** primary, **Aruba orange `#FF8300`** secondary, real elevation/shadows, radius scale, glass surfaces, ambient gradient. All existing CSS-var names preserved → app-wide re-theme.
- Tailwind tokens (`accent`, vendor colors, elevation shadows, Inter font).
- macOS overlay title bar (`titleBarStyle: Overlay`) → fixes the double-title-bar bug.

### Multi-vendor model (Aruba · Juniper · Mist)
- Expanded `DeviceType` to `aruba-cx · aruba-aos-s · aruba-ap · aruba-controller · juniper-junos · mist · generic` with a central `DEVICE_META` / `VENDOR_META` registry and per-vendor accent colors.
- New **Junos grammar** (`src/syntax/grammar-junos.ts`) wired into the highlighter + device auto-detection (operational & config modes, `ge-/xe-/et-` interfaces, `user@host>` / `[edit]` prompts).
- Device picker, sidebar, tabs, and status bar are now vendor-color-coded.

### Shell redesign (verified in-browser)
- Title bar: segmented control (Editor/API/AI) + grouped utilities + accent Connect button (replaced the cramped text-button wall).
- Premium empty-state hero with vendor chips.
- Sidebar: search/filter, vendor icons, live connection dots, hover folder actions.
- Tabs: vendor accent stripe, status dot, cleaner overflow.
- Status bar: vendor device chip, animated status.
- **Toast system** (`store/toastStore` + `Toaster`) and **inline dialogs** (`store/dialogStore` + `DialogHost`) replacing silent failures and native `window.prompt`/`confirm`.

### Correctness fixes (from the audit)
- **Persistence**: added backend `rename_session` / `update_folder` / `delete_folder`; sidebar rename/delete/expand + QuickConnect "save" now persist and reflect immediately (was in-memory-only).
- **CX REST (critical)**: collection GETs now send `?depth=2`, system GET sends `?depth=1` with correct CX field names (`platform_name`, `software_version`, `system_mac`); removed the malformed double-cookie (rely on `cookie_store`).
- **SSH**: output handler awaits instead of `try_send` → no more dropped bytes on bursty output (`show tech`).
- **Telnet**: disconnect now closes the socket + aborts the reader; `DO ECHO` instead of backwards `WILL ECHO`; IAC sequences carried across read boundaries.
- **Serial**: disconnect aborts the reader so the port is released.
- **Forwarder**: telnet/serial/local now drop the dead session from the manager on stream end → `is_connected()` is truthful.
- **Terminal**: streaming UTF-8 decoder (no multibyte corruption); WebGL `onContextLoss` fallback (no permanent blank); device auto-detect only when type is `generic` (no mid-session grammar thrash); soft foreground-only reset in the highlighter (no clobbering device bold/underline).
- **UX**: broadcast-to-zero now warns; connect success/failure now toasts; bell setting wired (`onBell`); AI tool output renders in `<pre>` (whitespace preserved).

---

## ✅ Done — Pass 2 (AI, MCP, branding sweep, polish)

- **MCP client (new, headline feature)**: `src-tauri/src/mcp/client.rs` — connects OUT to external MCP servers over stdio (JSON-RPC), discovers tools, and exposes them to the AI assistant **for every provider** (Anthropic + OpenAI-compatible alike, not Claude-only). Commands: `mcp_list_servers` / `mcp_save_server` / `mcp_delete_server` / `mcp_connect` / `mcp_disconnect` / `mcp_status` / `mcp_all_tools` / `mcp_call`. New **Settings → MCP Servers** UI (add/connect/edit/remove, live tool counts) + an "N MCP tools" indicator in the AI panel. Targets the user's `centralmcp` (Aruba Central/GLP, 145 tools) and any future Juniper/Mist server.
- **AI hardened**: request/connect timeouts; clear "no API key" + "is Ollama running?" errors; multi-vendor system prompt (Aruba CX/AOS-S + Junos + Mist) that adapts to the connected OS; tool-loop no longer discards gathered output; **Stop/cancel** button; model list updated (Opus 4.8).
- **Branding sweep → HPE**: AI prompt/messages, MCP server name, SSH-key comment, OpenRouter headers, `package.json`, README, editor template menu. Remaining "Aruba" mentions are legitimate (Aruba = one of the three vendors).
- **SSH key-file picker** in the auth dialog (Browse… → reads the file; no more raw-PEM paste) + redesigned to the new design system.
- **Editor + AI panel maximize/restore** (fullscreen).
- **Junos config templates** + Junos Monaco keywords (editor is now multi-vendor).
- **Settings toggle** rendering bug fixed.

## ✅ Done — Pass 3 (bug scrub: 32 confirmed → fixed)

A multi-agent adversarial scrub of the changed code found 32 confirmed bugs; the
high-severity + most medium/low ones are fixed:
- **MCP client concurrency**: refactored so the manager mutex is NOT held across spawn/handshake or the 60s tool round-trip (added `McpCaller` clone-and-release; connect/call/disconnect/delete orchestrated with brief locks). Reconnect now connects the new client BEFORE swapping (failed reconnect keeps the old one up).
- **MCP correctness**: tool `isError:true` results now surface as errors (not fed back as valid answers); reader survives a non-UTF8/bad line instead of dropping the whole connection; response-id correlation accepts int/float/string ids.
- **MCP security**: `mcp_creds.json` + per-server creds files written 0600.
- **AI**: Stop now actually aborts the tool loop (no more side-effecting commands after cancel); Ollama gets a long read timeout (no false "unreachable"); API key trimmed before the auth header; MCP tool-name collisions de-duplicated.
- **CX REST**: `Interface`/`Vlan` structs made lenient (`id`/`name` default, `vlan_tag`/`vlan_trunk` permissive) — interfaces no longer silently parse to `[]`; `uptime` derived from `boot_time`.
- **Transports**: SSH reconnect re-checks for a user disconnect after `connect()` (no orphaned session).
- **Frontend**: QuickConnect optimistic insert only on successful save + secrets stripped from the sidebar item; Terminal data-listener no longer re-subscribes on settings/deviceType change (read live from refs/getState) + decoder flushed on teardown + single reused AudioContext; tab close mid-connect tears down the backend; split-pane ref cleared on close; ConfigEditor Send filters Junos `/* */` and is gated on a connected session; default folder name aligned ("Sessions").
- **Deferred (low/cosmetic)**: per-chunk color-ANSI split reassembly; Junos keyword coloring in the Monaco editor; `irb.N` interface regex; a rare telnet SB+IAC tail edge. Tracked, not blocking.

## ✅ Done — Pass 4 (finish pass: last bugs + design-system consistency)

- **API Explorer**: the editable Base URL now actually drives requests (absolute-URL passthrough; `ArubaCxClient::new` + `ApiLoginRequest` accept a base_url) — was hardcoded to v10.09.
- **Config Editor Pull**: correct per-vendor paging command (AOS-CX/AOS-S `no page`, ArubaOS `no paging`, Junos `| no-more`) and paging is restored afterward.
- **Saved sessions** now persist jump-host / keep-alive / auto-reconnect / command / args / cwd (StoredSession + save_session extended; round-trips via camelCase serde).
- **Search overlay**: invalid regex no longer throws/breaks the box (guarded `new RegExp` + "Invalid regex" state).
- **SFTP**: Windows upload basename fixed (separator-agnostic).
- **Design-system consistency**: 142 hardcoded hex → design tokens across API Explorer, Bulk Runner, Config Editor chrome, and Settings (Monaco theme hex left literal as required). Search overlay rewritten to glass + tokens.
- All green: `cargo check` + `tsc` + `vite build`.

## ✅ Done — Pass 5 (roadmap features 1–4 + cencli ideas)

- **#1 SSH config import + host-key UI** — Settings → SSH & Host Keys: scan `~/.ssh/config` → import hosts; trusted host-key list with forget/re-trust. (`import_ssh_config`, `list_known_hosts`, `remove_known_host` + ssh_config parser.)
- **#2 Session tags** — right-click → Tags…; clickable tag chips; fuzzy host search; persisted (`set_session_tags`).
- **#3 SSH tunnels** — title-bar Tunnels modal: Local (-L) + dynamic SOCKS5 (-D) over any SSH session (`ssh/forward.rs` + `ssh_start/stop/list_forward`).
- **#4 Streaming AI** — token-by-token live bubble for Anthropic + all OpenAI-compatible providers, with full tool-call support + working Stop (`ai_chat_stream` SSE pump + `ai_done`/`ai_error` events).
- **cencli ideas applied/queued** (from Pack3tL0ss/central-api-cli): **fuzzy matching** (case-insensitive, ignores `-`/`_`) now powers the command palette (fixes the substring-only bug) and the sidebar host search. Queued cencli-inspired items below.

### cencli-inspired (Aruba Central) — queued
- **Output formats in API Explorer**: render array-of-objects responses as a sortable table + copy-as-CSV / YAML / JSON (cencli's `--out`).
- **Multi-account / workspace** for Central (cencli `--account`): store several Central credential sets, switch quickly.
- **Token paste + refresh** auth option for Central (in addition to client-credentials).
- **Expanded Central catalog** + **device "do" actions** (reboot / blink LED / bounce PoE / move) — overlaps with the user's centralmcp `aruba-ops` tools (prefer routing through MCP).
- **Batch ops** (bulk rename/move) building on the Bulk Runner.

## ✅ Done — Pass 6 (roadmap features 5–8)

- **#5 AOS-8 + AOS-S REST tools** — `api/onprem.rs`: ArubaOS-8 controller/conductor (login→UIDARUBA, `showcommand` JSON) + AOS-S (`/rest/v7`). New AI tools `aruba_aos8_show` / `aruba_aoss_rest` (auto-login with SSH creds), gated by the "Aruba device REST APIs" toggle by device type. (no Central needed)
- **#6 Juniper Apstra** — `ApstraClient` (AOS REST, token auth + auto-refresh). Settings → Juniper Apstra config + `juniper_apstra` AI tool (opt-in toggle). `apstra_configure`/`apstra_request`.
- **#7 SFTP ops + drag-drop** — backend mkdir/delete/rename; rewrote the browser on the design system with New Folder / Rename / Delete + native Tauri **file-drop upload**.
- **#8 SSH agent auth** — implemented `AuthType::Agent` via russh-keys AgentClient (tries each loaded identity); new **SSH Agent** tab in the auth dialog.

_All roadmap items 1–8 done. `cargo check` + `tsc` + `vite build` all green. Untested-against-hardware: the AOS-8/AOS-S/Apstra REST + SSH-agent paths (no devices here) — flagged for validation._

## ✅ Done — Pass 7 (network-engineer essentials)

- **Keyboard-interactive / 2FA auth** — SSH now falls back to keyboard-interactive (answering prompts with the password) when `password` auth fails — fixes TACACS+/RADIUS gear. (`ssh/client.rs`)
- **Serial line settings** — data bits / parity / stop bits in QuickConnect, threaded through to `SerialConfig` (was hardcoded 8N1).
- **Per-host startup commands** — QuickConnect field; commands run automatically on connect (`terminal length 0`, `no page`, …).
- **Output triggers** — `store/triggersStore` + Settings "Output triggers": toast (+ optional beep) when a keyword/regex appears in any terminal's output, debounced.

_Known follow-up: serial-settings + startup-commands aren't persisted on SAVED sessions yet (StoredSession field round-trip) — they work on the live connect path._

## ✅ Done — Pass 8 (cencli output + Apstra depth)

- **API Explorer output formats** (cencli `--out`): array-of-objects / map responses render as a **sortable table** with a Table↔JSON toggle and **copy-as-CSV**; handles CX depth=2 maps too.
- **Apstra endpoint catalog + target** in the API Explorer (parallel to Aruba Central): blueprints / anomalies / nodes / security-zones / virtual-networks / racks / configlets / systems / design (templates, rack-types, logical-devices, interface-maps) / resources (ASN/IP/VNI pools). Modeled on terraform-provider-apstra / apstra-go-sdk. The `juniper_apstra` AI tool now documents these paths.
- **Apstra configlet templates** in the editor (Junos NTP / SNMPv3 / syslog), from Juniper-SE/Apstra-configlets.

## ✅ Done — Pass 9 (cencli backlog + persistence)

- **Saved-session persistence** — serial line settings (data/parity/stop), startup-commands, AND the jump-host fields now round-trip through StoredSession (were dropped on save / not read back).
- **Central multi-account** — save/load/delete named Central accounts/workspaces (cencli `--account`); active account pushed to the backend.
- **Central token-paste auth** — for SSO accounts that can't use client-credentials (`central_set_token` + `configure_token`; used as-is, no refresh). New `CentralSettings` component with an auth-mode toggle.

_Remaining cencli item: device "do" actions (reboot/blink/bounce) — defer to MCP `aruba-ops` which already covers it._

## ✅ Done — Pass 10 (network intent / desired-state layer)

The headline assurance feature — declare desired state, evaluate live compliance:
- **Persistence** (`intent/mod.rs` → `intents.json`): durable store of intents (config + operational) AND their last evaluation result. Commands `intent_list/save/delete/set_result`.
- **Model**: kind (config | operational), scope (all / tags / device-types), command + matcher (contains / not_contains / regex / regex_absent), severity, per-device result.
- **Evaluation engine** (`utils/intent.ts`): runs each intent's command against in-scope connected sessions, matches output, records compliance (config drift) / anomalies (operational deviations), persists results.
- **Intent panel** (`IntentPanel.tsx`, Target icon in the title bar): define/list intents, "Evaluate all", per-intent run, status badges (ok/violation/unknown) with per-device breakdown.
- **AI hook**: `evaluate_network_intents` tool — "check the network against our intent and explain the failures."

## ✅ Done — Pass 11 (app-wide adversarial bug scrub + fixes, 2026-06-02)

14-subsystem adversarial scrub (97 agents): 83 candidates → **71 confirmed** (1 critical, 16 high, 29 medium, 25 low), 9 refuted, 3 uncertain. **67 fixed** across backend + frontend (git: `30d577c`, `c9674ef`, `3b3b810`, `314b082`).
- **Critical**: corrupt/wrong-version `vault.enc` was silently re-initialized to EMPTY on next unlock, wiping every saved secret → load() now errors + refuses to overwrite, atomic temp+rename writes, corrupt file preserved.
- **Security**: plaintext secrets removed from localStorage (Central token/secret, Apstra password, API key, per-account secrets via `partialize`); `ai_keys.json` + vault + MCP creds now 0600 (atomic create); vault plaintext zeroized.
- **Backend correctness**: SSH port-forward channel leak (JoinSet); `want_reply=true` PTY/shell; jump-host key/agent auth; known_hosts locked+atomic; keyboard-interactive no longer blasts the password into OTP prompts; MCP reader busy-spin + server-request id collision + collision-free creds filenames; telnet `IAC IAC`; SFTP streaming + overwrite guard; AI SSE byte-buffered UTF-8 + idle timeout + real cancel + no-content error; buffer-leak / ghost-session / double-disconnect.
- **Frontend correctness**: destructive-action confirms (Reset, MCP delete, SFTP drop/overwrite, ConfigEditor discard); dialog FIFO queue; toast cap; BulkRunner command-snapshot + empty=error; ApiExplorer version + render caps; Terminal decoder-reset-on-reconnect + trigger cross-chunk + add-time regex validation; AI Stop kills the bubble + backend stream; **Apstra now actually works** (camelCase arg + `/api/api` path); startup-commands on auth-dialog retry; re-open-connected-host focuses tab.

**Deferred (deliberate, with rationale):**
- **onprem-1** — TLS verify default: kept permissive for on-prem device REST (self-signed field gear is the norm; flipping to verify-on would break logins by default). ApiExplorer has a per-login toggle and the Apstra failure is no longer swallowed. Proper follow-up: a global "verify device TLS" setting (product decision).
- **onprem-5** — AOS-8 UIDARUBA-in-URL + 401 re-login: token-in-query is the documented AOS-8 mechanism; changing it / adding re-login needs real hardware to validate.
- **term-5** — redundant global resize dispatch: cosmetic RPC churn; removing risks a missed refit.
- **aw-4** — unreachable `!result.success` branch: dead-code cleanup only, no behavior change.

_Still not exercised against real hardware (no gear/keys here): AOS-8/AOS-S/Apstra REST, ssh-agent, keyboard-interactive, MCP, CX REST, and the new concurrency/capture paths — reasoned, not runtime-proven._

## ✅ Done — Pass 12 (terminal UX: iTerm2-class ergonomics, 2026-06-03)

- **Resizable left sidebar** — drag the right edge (170–560px), width persists via settings (`sidebarWidth`). `useResizablePanel` gained `edge`/`onCommit` opts (right-side panels unchanged).
- **Terminal zoom** — trackpad pinch (ctrl+wheel), Cmd/Ctrl +/− and Cmd/Ctrl 0 reset, clamped 8–24pt; propagates live to every open terminal via the existing fontSize effect.
- **File drop → path insert** — dropping a file on the terminal inserts its shell-quoted path at the cursor (iTerm2-style; trailing space, no newline) — built for AI-CLI workflows. SFTP browser keeps drop priority while open; dashed-border hint overlay on hover.
- **Pop-out session windows** — tab button pops a session into its own OS window (`pop_out_session` + `popout-<id>` label routing in `main.tsx` → `PopOutTerminal`). Scrollback seeds from the captured output tail; main-window terminal stays mounted-but-hidden so pop-in restores full history; only the pop-out fits the PTY (no cols/rows fights). Tab shows popped state; click focuses the window; closing it restores the tab.
- **Paste guard** — multi-line pastes confirm first (line count + warning), then go through `term.paste()` so bracketed-paste TUIs still work.
- **Tab activity dots** — background tabs pulse a vendor-colored dot when new output lands (`unseenOutput`), cleared on view.

### iTerm2/xterm parity backlog (from the 2026-06-03 sweep)
Already had: search overlay, multi-send/broadcast, vault (≈password manager), profiles/tags, WebGL-class renderer, URL clicking, scrollback/cursor settings, **session logging** (`start_session_log`), **output triggers** (`triggersStore`).
- **Paste history** (Cmd+Shift+H) — ring buffer of recent pastes/sends.
- **Semantic history** — Cmd-click a file path in output to open it in the editor panel.
- **Regex toggle in search overlay** (SearchAddon supports it).
- **Smart selection** — tune `wordSeparator` so double-click grabs IPs/paths cleanly.
- **Restore window arrangement** — reopen last session set + pane layout on launch.
- **3+ split panes / grid** — replace the 2-pane model with a flat pane list (research notes in Pass-12 planning); resizable dividers.
- **Drag a tab out → pop-out window** (today it's a button; iTerm2 does both).
- **Paste-guard setting** — per-user toggle + line-count threshold.
- **Silence/activity notifications** — notify when a long command finishes on a background tab.

## ✅ Done — Pass 13 (adversarial bug scrub #2 + features, 2026-06-11)

A 49-agent review (8 finder dimensions, every finding adversarially verified) confirmed
33 issues (27 other claims refuted); all 33 are fixed:

### Critical / high correctness
- **SSH dead-peer detection actually works now**: a retained `data_sender` clone kept every SSH output channel open forever, so server-side drops never EOF'd the supervisor — no "disconnected" event, no auto-reconnect, frozen tab showing connected. The handler now owns the only sender.
- **One wedged session can no longer freeze every tab**: removed the outer `Arc<AsyncMutex<SessionManager>>` (manager has internal per-session locks); `send_data`/`resize`/`disconnect` no longer serialize behind a global lock held across network writes.
- **Teardown can't wedge**: `remove_session` removes from the map first, then disconnects under a 5s timeout — a send blocked on an exhausted SSH window no longer makes Disconnect hang forever.
- **Supervisor ownership generations**: reconnect-vs-user-reconnect races no longer let an old supervisor kill the new connection (generation tokens in `SessionManager`; `remove_session_if`/`contains_gen`).
- **Port-forwards torn down on peer-close/reconnect** (zombie listeners on dead handles).
- **`sendAndCapture` re-run bug**: running the same command twice with identical output returned an empty capture (tail-anchored `lastIndexOf`); Intent re-evaluation / Bulk Runner / AI captures now slice by length with a trim-aware fallback.
- **AI panel unmount cancels the tool loop** — closing the panel mid-run no longer leaves the AI typing commands into the live device with no Stop button.
- **`cli_passthrough` hardened**: 180s timeout + `kill_on_drop` (no more permanently hung AI chat / leaked shells); prompt truncation now keeps the tail (the user's question) instead of cutting it.
- **Aruba Central creds mode**: client-credentials tokens are now minted from HPE GreenLake SSO (`sso.common.cloud.hpe.com`) with legacy fallback + an actionable error (classic apigw never supported `client_credentials` — the old code could never authenticate).
- **Font-size zoom resizes the PTY** (`term.onResize` → `resize_terminal`); ANSI sequences split across highlight batches no longer corrupt colors.
- **Confirm dialogs take keyboard focus** — Enter/Escape answer the dialog instead of leaking keystrokes (including that Enter!) to the live device behind the paste guard.

### Medium / low
- Backup import no longer silently drops AI agents + session-agent assignments; built-in snippets have stable IDs (+ persist migration) so merge-imports don't duplicate them.
- Intent-pack matchers no longer always-violate on healthy devices (Junos BGP header, CX interface names) — per-line anchored regexes, validated against realistic output.
- Crashed MCP servers are reaped (dead flag; status/tools reflect reality; pending-map leak fixed).
- Telnet IAC carry: trailing `IAC IAC` escapes and split subnegotiations no longer corrupt/drop bytes.
- Local-shell tabs reap their PTY children (no zombie processes); telnet/serial/local emit `connected` before the forwarder (no ghost-connected tab on instant death).
- Popped-out sessions: Ctrl+1-9/Ctrl+Tab/palette skip or focus them (no blank main area); Ctrl+W can't disconnect under a live pop-out.
- Split-pane sessions aren't flagged as "background activity"; `terminal_data` listener no longer leaks on fast unmount; semantic-link off-by-one fixed.
- API Explorer: login failures render + toast with a busy spinner (were 100% silent); StrictMode no longer wipes saved requests; hover-white-on-white fixed.
- Light theme: AI headings/bold and Monaco editor now follow the theme (`aruba-light`).
- Settings/Bulk Runner/Device Mapper dismiss on Escape + backdrop click; paste-history popover got a click-away layer; intent delete asks for confirmation.

### Features
- **Telnet NAWS (RFC 1073)** — window size advertised on connect and on every resize (with IAC escaping).
- **AOS-CX CSRF tokens** — captured at login, attached to all mutating REST requests (writes work on 10.09+ firmware; older firmware unaffected).
- **Recent connections** — new `recentStore` (capped, deduped); hero shows the last 5 with vendor dots + relative time, palette gets "Recent:" entries; one click reconnects.
- **Terminal color schemes** — Settings → Appearance: GreenCLI (follows app theme), Dracula, Nord, Solarized Dark/Light, Gruvbox Dark, One Dark.

### Cleanup
- Removed the dead app-as-MCP-server stub end-to-end (`mcp/server.rs`, 5 unused Tauri commands, `AppState.mcp_server`).
- Removed the dead `anthropicApiKey` settings field and the no-op Word Wrap toggle.

All green: `cargo check` + `tsc` + `vite build`; shell/Settings smoke-tested in-browser.

## ⏭️ Next — remaining backlog

- **Vault auto-lock on idle** — MEDIUM, S.
- **SFTP transfer progress/queue + cancel; chmod** — MEDIUM, M (rename/delete/mkdir/drag-drop ✅ done).
- **Mist Cloud API catalog** in the API Explorer (token auth) + Junos NETCONF. _(Mist reachable via MCP today.)_
- **Classic Central 3-leg OAuth** (username/password/customer_id → auth code → refresh) if creds-mode-on-classic is wanted; today: paste-token mode for classic, client-credentials for new Central/GLP.
- **Parallel bulk execution** (Bulk Runner is deliberately sequential today).
- iTerm2 parity leftovers: regex toggle in search, smart selection (`wordSeparator`), restore window arrangement, drag-tab-out, per-pane grid beyond 4.
- cencli-inspired Central items (output formats/CSV, multi-account, device "do" actions via MCP, batch ops).

_Full per-finding detail lives in the audit outputs; ping to regenerate._
