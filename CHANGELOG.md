# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Release workflow: one run at a time. A run that starts while another is going waits for it, so
  two runs for the same version can't upload into the same draft at once and replace each other's
  update files and keys after update-files has checked them.

### Fixed
- Windows: an MCP login that GreenCLI 2.0.0 saved for a server with a capital letter (or a
  character such as `/`) in its name is found again. It moves to its new Credential Manager name
  the first time it is used. Servers whose names differ only in case keep their own logins.
- With two copies of GreenCLI open, an AI key or MCP login saved, changed or removed in one is
  used by the other at its next request, as in 1.9. Before, the other copy kept the old key until
  it restarted, and renaming a server there could bring back a login removed in the first copy.
- greencli-mcp reads the same data folder as GreenCLI: the command MCP Servers copies and the
  export pass it as `--data-dir`. On Linux with `XDG_DATA_HOME` set, Casper started greencli-mcp
  without that variable, so it read another folder and found no devices, configs or intents.
  Export again to update a file made before. When the data folder isn't there, greencli-mcp's
  tools now say so instead of answering with empty lists.

## [2.0.0] - 2026-10-02

### Added
- **Automatic updates** (macOS and Windows): GreenCLI can update itself from its GitHub releases.
  Settings → **Updates** shows the version, **Check for updates** and **Check once a day** (on by
  default). When a new version is downloaded and checked, you see "GreenCLI X is ready." with
  **Restart to update**. Nothing installs until you tap it and say yes. The box says how many open
  sessions will close, warns about unsaved Config Editor edits or an AI answer still running and, on
  Windows, reminds you to close Claude Code and Casper. It won't restart while a Change Job, bulk run,
  Config Editor send or SFTP upload or download is going.
- Every update is checked against its signature before it can install. Each release build signs
  its own files, so there is no signing key to keep and no secret to set.
- On Windows, MCP servers stop only when the installer starts. If the installer can't start, they
  come back. If it starts and then shows "Error opening file for writing" (Claude Code or Casper
  still runs greencli-mcp), close them and click **Retry**.
- **greencli-mcp**: a read-only MCP server for Casper and Claude Code that ships next to the app.
  It has seven read tools: `access_check`, `list_devices`, `list_archive_devices`,
  `list_config_history`, `get_config`, `get_config_diff` and `list_intents`. `list_archive_devices`
  finds config history kept under a device's old name, after a rename or delete in GreenCLI. It
  only reads GreenCLI's data folder. It never writes a file, opens a network connection or starts a
  program. The device list has no passwords, user names, notes or startup commands.
- **Hidden copies**: when a config is captured, GreenCLI also saves a copy with secrets hidden (the
  same filter the AI uses). greencli-mcp serves configs and diffs only from these copies, and
  refuses a snapshot without a current one instead of serving it raw. The Config Archive panel has a
  new **Make hidden copies** button for older snapshots. After a secret filter change, GreenCLI makes
  the old copies again at start.
- **MCP Servers** shows where greencli-mcp is, with **Copy** buttons for its path and for the
  `claude mcp add --scope user greencli` command (user scope, so Claude Code has it in every
  folder). **Export for Casper / Claude…** adds it as `greencli`, and now works with no saved
  servers.
- **Apple signing, ready to turn on**: release builds sign the Mac app (with greencli-mcp inside)
  and have Apple notarize it and the `.dmg` once the five Apple secrets are set (see
  docs/SETUP.md). With only the certificate and its password, the app is signed but not notarized.

### Changed
- **Tauri 2**: GreenCLI now runs on Tauri 2. Settings, saved sessions, the vault, logins and other
  data stay where they were, and the app keeps the same install ID, so 2.0 installs over 1.9.
  Pop-out windows, Open/Save dialogs, the clipboard and file drops work as before.
- **AI keys and MCP logins in the system password store**: macOS Keychain, Windows Credential
  Manager, or the Secret Service on Linux. At first start, 2.0 moves them from the 1.9 files
  (`ai_keys.json`, `mcp_creds.json`), reads each one back, and only then deletes the files. The AI
  key field and the MCP server form say where they are kept.
- If an old key file can't be read, it stays where it is and Settings shows its path. If some keys
  didn't move, Settings says so, they keep working from the old file, and GreenCLI tries again at
  the next start. Keys you change or remove in the meantime stay as you set them.
- Without a system password store (some Linux setups), keys stay in the 1.9 private files.
- **MCP login files only while a server runs**: a stdio server's saved login is written to a new
  private file in `mcp_creds/` when it connects, and deleted when the server stops, exits or fails
  to connect. Files left by a crash are deleted at the next start. A second copy of GreenCLI leaves
  the first one's files alone.
- Removing an MCP server also removes its saved login. If the password store can't be reached,
  nothing is removed.
- **Web links open in your browser**: Ctrl+click (Cmd+click on a Mac) a web address in a terminal
  or in the Config Editor (and its compare views) to open it in your default browser, on every
  system. In 1.9 a click opened it in a small window, and only on Windows. The Central docs links
  in API Explorer open in the browser too (they did nothing in 1.9).
- **The window shows as soon as it has drawn.** When the system holds back the first frame (Linux
  does), it shows after half a second instead of after 4 seconds.
- **Linux builds need webkit2gtk-4.1 2.40 or newer** (Ubuntu 22.04 with updates, or newer; CI uses
  24.04) and Rust 1.90 or newer. See docs/SETUP.md for the packages.
- Release workflow: manual runs have a **publish** box (untick it to only build), every release
  starts as a draft, and only three kinds of job can write to the repo: the release job makes the
  draft, the build jobs upload into it, and update-files writes `latest.json` and checks it. One
  job makes the draft and one writes `latest.json`, so builds that finish together can't make two
  drafts or drop each other's update entries. Re-running a job changes a draft only: once the
  release is published, the build jobs and update-files stop with "already published". A later
  `release/**` push or manual run that uploads into a draft also moves its future tag to the commit
  it built. `latest.json` gives each update file's download link, not its GitHub API address, so
  update downloads don't count against GitHub's API limit of 60 requests an hour per address (a
  busy office network could hit it, and the update then failed).

### Fixed
- An AI key or MCP login that fails to save now shows a message. Before, it failed with no
  message. A failed login save keeps the server form open.
- The AI panel stops asking for an API key once a key typed in Settings is saved. Before, closing
  Settings with Escape right after typing the key left "Add an API key" up until the next message.
- A link in an AI answer opens in your browser, with a click or a middle click. Before, clicking one
  loaded the website in place of GreenCLI, and only quitting and starting again (which closes your
  sessions) brought the app back.

### Security
- AI keys and MCP logins are no longer plain files in the data folder (on macOS and Windows, and
  on Linux with a Secret Service), so reading or copying that folder doesn't give them away.
- An MCP login is on disk only while its server runs, in a private folder.
- Update checks use HTTPS to GitHub only (github.com, api.github.com and GitHub's download hosts),
  and the update file must be a file of a GreenCLI release. The app takes the update list and the
  key from the same release, and checks the download's signature before it shows **Restart to
  update**. It never goes back to an older version, and drafts don't count.
- greencli-mcp reads only the data folder, and shows configs only with secrets hidden.
- The app window may use only a short list of Tauri's built-in functions (windows, dialogs,
  clipboard, events): the same as 1.9, plus showing a window and listing windows. GreenCLI's own
  functions are not limited by this list, as in 1.9.

### Upgrade notes
- **Install 2.0.0 by hand once.** 1.9 has no updater: get 2.0.0 from the GitHub Releases page and
  install it over 1.9. Later versions can update themselves.
- **On a Mac, move GreenCLI to Applications** and open it from there. Updates don't work while it
  runs from the disk image or straight from Downloads.
- **Back up your keys first.** At first start your AI keys and MCP logins move into the password
  store and the old files are deleted. 1.9 can't read the password store, so going back to 1.9
  loses them. Before you install, copy `ai_keys.json` and `mcp_creds.json` from the data folder
  (macOS `~/Library/Application Support/com.choatelabs.greencli/`, Windows
  `%APPDATA%\com.choatelabs.greencli\`, Linux `~/.local/share/com.choatelabs.greencli/`; see
  docs/SETUP.md §3) to a private place, or be ready to enter the keys again.
- **Copying only the data folder to another computer does not copy your keys.** They stay in this
  computer's password store. Enter them again on the new one. On a Linux computer with no keyring,
  first delete `secret_store.json` from the copied folder while GreenCLI is closed.

### Known limits
- Casper's own file tools can read files outside its folder. AI keys and MCP logins in the
  password store are out of its reach as files, but session logs, archived configs and the login
  file of a running MCP server can still be read. With no system password store (or an old 1.9
  file left over), `ai_keys.json` and `mcp_creds.json` are plain files it can read too. Settings
  says so.
- The update signature catches a broken, cut-short or swapped download, and a file from anywhere
  else. It does not protect against someone who can publish releases on the GitHub account: they
  could publish their own files and key. This is the same trust as downloading GreenCLI from the Releases page. Keep
  two-factor login on for that account.
- Linux gets no automatic updates (there is no Linux release build).
- A greencli-mcp diff can't show a changed password: both sides show it hidden.
- On Windows, a greencli-mcp that Claude Code or Casper is running can block the installer. Close
  them before you update (Settings → Updates says so).
- If the Mac app isn't signed (no Apple secrets), macOS may ask to allow Keychain access again
  after each update.
- On Windows, processes a CLI leaves behind after it ends by itself are not stopped.

## [1.9.0] - 2026-10-02

### Added
- **Folder view in the Config Editor**: the folder button opens a folder (Ansible playbooks,
  scripts, config backups) as a file tree beside the editor, like VS Code. A click opens the file
  in a tab or goes to its tab; type to find a file. The last folder is remembered. Pictures,
  archives and files over 5 MB are greyed out.
- **Casper as the AI** (Settings → AI Assistant → **Casper (no key)**): the AI panel answers
  through Casper on your computer, with its own sign-in. Each question gets a fresh folder (or a
  project folder you pick; **Check Casper** tests it). GreenCLI never turns Casper's sandbox off,
  refuses flags that would, and won't start Casper while a port forward or a local MCP server is
  open. Stop ends the answer.
- **MCP approval box**: every MCP tool that might change something now asks first, with the tool,
  what it can do in plain words, the real tool behind a router like `invoke_tool`, and the full
  arguments. Choose **No**, **Yes, this once**, or (plain reads only) **Yes, until GreenCLI
  closes**. Router calls, calls where the AI set `confirm` or turned off `dry_run` itself, and
  calls GreenCLI can't fully read always ask. Stop closes the box and cancels a running call.
- **Allow writes per MCP server** (off by default): with writes off, tools that change or delete
  things are hidden from the AI and blocked by GreenCLI, even through a router. Known servers
  (HPE networking, Central/centralmcp, Grafana, ClearPass) also start with their own read-only
  settings. An `access_check` tool, when a server has one, shows whether the login is read-only.
- **Junos**: "Run plain show commands without asking" for Junos MCP servers.
- **Export for Casper / Claude…** in MCP Servers: saves a `.mcp.json` that Claude Code and Casper
  both read, with every password, token, key and `user:password` turned into a `${NAME}`
  variable, and lists the names to set.
- Plain `http://` to another computer gets a warning in the MCP server URL and Ollama URL fields.

### Changed
- The **Read-only Auditor** agent is enforced, not just a prompt: only plain read commands and
  read-only MCP tools run, and anything else is refused. It no longer accepts the `sh` short
  form (type `show`).
- Stdio MCP servers get only basic system variables (PATH, HOME, locale, temp folder, ssh-agent,
  proxy and certificate settings) plus their own Env entries, instead of everything from your
  shell. A server that needs an API key from your shell needs it in its Env box now.
- Servers saved before 1.9 start with writes off and show a one-time note.
- MCP connections use protocol 2025-06-18 and read the servers' tool hints.
- Stop also ends a Local CLI answer, and quitting GreenCLI stops a CLI that is still running.

### Fixed
- If `mcp_servers.json` can't be read, saving no longer overwrites it.
- A Stop or timeout during an MCP HTTP session restart no longer breaks the server connection.

### Known limits
- Casper's own file tools can read files outside its folder, including GreenCLI's saved AI keys,
  MCP logins and session logs. Settings says so. A full fix needs a Casper change or moving those
  keys into the system keychain.
- On Windows, processes a CLI leaves behind after it ends by itself are not stopped.

## [1.8.0] - 2026-10-02

### Added
- **Send selected lines**: select lines in the Config Editor, then the arrow next to **Send** (or
  right-click) → *Send selected lines*. Only those lines go out, with the usual confirm,
  stop-at-first-error and send bars.
- **Send safely as a Change Job**: the arrow next to **Send** (or right-click) opens Change Jobs
  with the tab (or the selected lines) and this device already filled in. You get a dry run,
  then the switch's own rollback timer (AOS-CX `checkpoint auto`, Junos `commit confirmed`).
  Lines the job adds itself (`commit`, `checkpoint auto`) are taken out and named.
- **Ask AI about these lines** (editor toolbar, or right-click): explain them, check them for
  mistakes, fix the problems GreenCLI found, convert Aruba CX ↔ Junos, or ask your own question.
  It covers the selected lines, or the whole tab. Secrets are hidden before anything goes to the
  AI, and nothing goes if they can't be.
- **Review AI suggestions as a diff**: code in the AI's answer gets **Review in Editor**. It opens
  a diff against the lines you asked about. Drop a change with the arrow beside it, edit the right
  side, then **Apply** (Ctrl+Z undoes it) or **Discard**. Nothing changes until you click. Lines
  the AI only saw as `<secret hidden>` get their real value back from your tab. A converted
  config, or lines that changed since you asked, open in a new tab instead.
- **Edit in the Diff view**: when you compare with what you pulled or with a file, the right
  side is your tab. Edit it there, or click the arrow beside a change to take the left side's
  lines.

### Fixed
- Leaving the Diff view no longer throws a "TextModel got disposed" error.
- Code blocks without a language in the AI panel show as blocks, not as inline code.

## [1.7.0] - 2026-10-02

### Added
- **Casper tab**: Quick Connect → Local → **Casper** starts Casper in a terminal tab, in the
  **Start folder** you pick (your project). The folder is the tab's working directory, never a
  command-line argument.
- **Problems panel in the Config Editor** (Ctrl+Shift+M, or click the problem count): every problem
  in the tab with its line and column, filterable by errors / warnings / tips. A click selects it
  and the panel stays open while you work down the list. It replaces the drop-down list.
- **Editor status line**: "Send to: core-sw1 · Aruba CX · CONFIG MODE · pulled 12 min ago", named
  like the terminal tab. When the tab is for another vendor than the device (a Junos tab with an
  Aruba CX session) a red line says so.
- **After a Send, a bar beside each line shows how far it got**: green for lines that went out with
  no error, red for the line the switch rejected, amber for a question or for lines that went out
  after the error, grey for lines never sent. A line above the editor sums it up ("3 sent ·
  1 rejected · 3 not sent") with **Clear marks**. The bars stay with that tab until the next send.
- **The Send dialog counts the problems** ("1 error, 2 warnings") and lists the first five with their
  lines, errors first, plus the vendor warning. It names the device like its terminal tab. A tab in
  a code language still gets the device checks, since it is going to a device.
- **Copy with secrets hidden** (the eye button next to Copy in the Config Editor): copies the tab
  with passwords, keys, SNMP communities and private keys swapped for `<secret hidden>`, using the
  same filter as the AI. Safe to paste into a ticket, chat or email. If the filter can't run,
  nothing is copied.
- **Plain-text passwords get a tip** in the editor: `password plaintext …`, `key plaintext …`,
  `auth-pass plaintext …` and the like are underlined in blue with a pointer to Copy with secrets
  hidden. It stays out of the Send dialog, since setting a password is what a send is for.
- **Hover cards for Aruba CX and Junos**: hover a line in the Config Editor (VLAN, access or trunk
  port, LAG, VLAN interface, static route, NTP, SNMP, RADIUS, commit confirmed …) to see what it
  does in plain words and how the other vendor writes it.
- **Passwords written into code and data files are flagged**: in YAML, JSON, Python, shell, `.env`,
  JavaScript/TypeScript, PowerShell and Terraform tabs, a password, token, API key, RADIUS/TACACS
  key or SNMP community written as a value gets a warning. Variables, vault lookups (`{{ … }}`,
  `!vault`, `${ENV}`, `os.environ`), placeholders and UI labels are left alone.
- **Quick fixes (Ctrl+. or the light bulb)** on Config Editor problems: strip terminal junk from the
  tab, comment out a risky or rejected line (`!` on Aruba, `#` on Junos) so it isn't sent, add
  `commit confirmed 5` to a Junos tab, or swap a plain-text password for a blank (`${password}`).
- **Go to Symbol (Ctrl+Shift+O, or the Outline button)**: type to jump to any interface, LAG, VLAN,
  router or Junos section by name, like VS Code. Junos works in set or brace style; code files use
  the editor's own symbols. It replaces the old Outline list.

### Fixed
- Confirm dialogs kept their text on one line: the Send preview, the problem list and the SFTP
  upload list ran together. Line breaks and indents now show, and a long message scrolls.

## [1.6.1] - 2026-10-01

### Security
- **Typing in the Config Editor could go to the device.** GreenCLI hands keys pressed outside a text
  field back to the terminal. In a Chromium WebView (WebView2, so the Windows app), the editor takes
  typed text in a plain element instead of a text field, so with a session connected every key went
  to that session: typing a line and Enter in the editor ran it on the switch, and the editor stayed
  empty. Keys typed in the editor now stay in the editor, and editor shortcuts (Ctrl+F, Ctrl+K, …)
  are the editor's again.

## [1.6.0] - 2026-10-01

### Added
- **Config Editor problems, like VS Code.** Risky lines ("reboots the switch", "removes the VLAN"),
  blanks still to fill in (`${vlan_id}`, `<replace-me>`, a hidden-secret marker), terminal junk
  from a captured log, and a Junos edit with no commit are underlined, marked in the scrollbar,
  and counted in the toolbar ("1 error, 2 warnings"). Click the count for a list that jumps to
  each one; F8 / Shift+F8 step through them. Comment lines, which are never sent, are never
  flagged. The line the switch rejected on Send shows in red with the switch's own words, and the
  Send dialog warns when a blank or marker is still in the text.
- **The editor knows Aruba and Junos.** Ctrl+/ comments a line (`!` for Aruba, `#` and `/* */`
  for Junos); a double-click picks `1/1/5`, `ge-0/0/0.100` or `10.1.1.1/24` whole; brackets
  match; blanks show in bold amber; the keyword list colors the text (it was never hooked up);
  the block you're in stays on top as you scroll. The archive's diff uses the device's colors too.
- **Snippets you Tab through.** Type `cx-access`, `cx-trunk`, `cx-lag`, `junos-trunk`, … at the
  start of a line (or pick from *Snippets*), then Tab from blank to blank.
- **Diff → compare with what you pulled.** The Diff button is now a menu: the running-config you
  pulled from each device, or a file. Opening a file no longer replaces what you pulled.
- **Right-click → Open in Editor** in a session: the selected text opens in a new Config Editor tab
  in the device's language (trailing spaces and blank edges trimmed), and the Editor panel opens.

### Fixed
- **SSH session colors follow the theme.** The syntax highlighter used fixed 256-colors tuned for
  one background, so on white some were hard to read (ports/IPs ≈ 2.6:1) and in dark the prompt and
  comments were dim. It now uses the terminal theme's own colors: light/dark and any color scheme
  (Dracula, Nord, …) apply, text already on screen re-colors when you switch, and every color meets
  the AA contrast bar on GreenCLI's backgrounds (comments, meant to be dim, at least 4:1). The dark
  theme's gray is lighter (#6e7681) for the same reason.
- **Comment lines are dimmed** in sessions: `!` lines on Aruba and `#` / `/* */` lines on Junos. The
  comment color existed but nothing used it.

### Security
- **The AI no longer sees device secrets.** Every AI tool result (terminal output, device REST,
  MCP results, intent summaries and error text) goes through one secret filter before the model
  sees it. Passwords, hashes, RADIUS/TACACS keys, SNMP communities and SNMPv3 pass phrases,
  Wi-Fi and VPN keys, and private keys show as `<secret hidden>`, and the tool row gets an
  "N secrets hidden" note. The rules come from Casper (`src/utils/secrets/`, copied, with a check
  that the copies still match). Secrets are hidden first and the result is capped after, so a cut
  can't drop a `BEGIN PRIVATE KEY` or `snmp {` line and leak what follows it. A page the AI gets by
  pressing Space at `--More--` is checked as if it starts inside a block.
- A tool call that sends `<secret hidden>` back (a command, REST body or MCP argument) is refused
  before any dialog or device contact: it would write the marker over the real secret.
- If the filter can't run on a system (an old Linux WebKitGTK), the AI gets "output not shown"
  instead of unchecked output.

### Changed
- macOS 13.3 (Ventura) or newer is required: the secret filter needs regex features older macOS
  WebKit lacks. The TypeScript target and lib move to ES2022.
- The best-practices audit judges password storage by type (plaintext vs hashed, Cisco type 7 vs
  8/9), since values now arrive hidden. A well-known default SNMP community (public/private) is
  still reported, without showing which one.

## [1.5.1] - 2026-10-01

### Security

- **AI terminal commands can't hide extra lines.** A command the AI sends is now
  split on every line break the device treats as Enter, a bare carriage return
  included. Before, `show version` followed by `\r` and config lines passed as
  a read and ran with no prompt. Commands with control characters (backspace,
  Tab, Ctrl-Z, ESC) are refused, because the device acts on them and the line
  you approve may not be the line that runs. The Bulk Runner, multi-send bar
  and Change Job checks use the same line rules.
- **The AI never types into a local tab.** With no device connected, the AI's
  terminal tool used to fall back to the active local tab: a shell, or a
  Claude/Kimi/Copilot CLI. It now only uses device sessions (SSH, Telnet,
  Serial) and says so when none is connected.
- **The AI's REST tools stay on the device.** `aruba_cx_rest` and
  `aruba_aoss_rest` refuse absolute URLs and anything that isn't a path
  starting with `/`, enforced in the backend. The API Explorer still accepts
  a full URL you type.
- **HTTP error messages no longer include the URL.** The AOS-8 session token
  (`UIDARUBA`) rides in the query string, so a failed request could put it in
  an error the AI reads. Device, Central and MCP errors now leave the URL out.
- **The intent webhook URL is treated as a secret.** Slack/Teams webhook URLs
  work as passwords: they are left out of backups, a backup can no longer set
  one, and logs name only the host. The plain-http loopback check no longer
  accepts host names that merely start with `127.`.
- **Files that can hold secrets are owner-only on macOS and Linux.** Saved
  sessions (startup commands), the MCP server list, intents and the config
  archive are written `0600` in folders only you can open, and files an
  older version wrote readable by other local users are fixed at startup.

### Fixed

- An intent's case-sensitive setting is kept when the intent is saved.

### CI

- Releases run the full test and lint workflow before building installers.
- CI runs the production-bundle smoke test and a Windows compile check.

## [1.5.0] - 2026-09-27

### Added

- **Change Jobs** (activity bar / command palette): push one config block to many
  devices picked by folder, tag, host or open tab, with `${var}` values per
  device from a CSV. A dry run shows exactly what each device gets; the job
  runs on one canary device and waits for your OK before the rest; it stops
  at the first device error, takes before/after config snapshots with a diff,
  and wraps changes in Junos `commit confirmed` / AOS-CX `checkpoint auto` so
  an unconfirmed change rolls itself back. Results grid with CSV export.
- **Shared logins** (Settings → Connections & Security): one saved login (e.g. your TACACS
  account) used by many hosts — set it as a folder's default, override per
  host. Changing its password once updates every device that uses it. Jump
  hosts can use a login or a vaulted password; jump auth gains
  keyboard-interactive.
- **Import hosts**: from CSV (with a template), a SecureCRT sessions folder or
  XML export, Aruba Central, Juniper Mist, or `~/.ssh/config` — all through
  one preview that skips hosts you already have.
- **Several sessions to one saved host**: "Open new session",
  Shift+double-click, or Duplicate tab ("core-sw-01 (2)"); a tab right-click
  menu (Duplicate, Reconnect, Disconnect, Rename, Pop out, Close others /
  disconnected).
- **Tabs read the device prompt**: tabs named by the device's hostname and
  tinted amber with a CONFIG badge while the device is in config mode
  (AOS-CX, AOS-S, AOS-8, Instant, Junos); the status bar and multi-send bar
  show it too.
- **Session logging**: plain-text logs (control codes stripped) named
  `host_YYYY-MM-DD_HHMMSS.log`, an option to log every session
  automatically, a chosen log folder, optional per-line timestamps and
  "Reveal log folder".
- Keyboard: tab switching from inside a session (Ctrl+Tab, Ctrl+PgUp/PgDn,
  ⌘1–9 / Alt+1–9), Ctrl+Shift+F/T/P on Windows/Linux, F3 / ⌘G find next, and
  shortcut hints that show ⌘ on macOS.
- Serial: port dropdown (lone USB console preselected), baud default by
  device type (AOS-CX 115200), and a "Send BREAK" button.
- Quick Connect parses `user@host:port`; saved hosts get **Edit…**, show
  user@host, and Enter in the sidebar search connects to the top match.
- "System" theme that follows macOS / Windows; Option-as-Meta setting on Mac;
  right-click Copy & Paste / Find selection / Save scrollback; pop-out
  windows get a header with status, Reconnect, Find and Dock.

### Changed

- **New layout.** An activity bar down the left side replaces the Tools menu:
  one click opens Sessions, Editor, API, AI, Bulk Runner, Change Jobs, Config
  Archive, Network Intent, SSH Tunnels, SFTP or Import Hosts, with Help and
  Settings at the bottom. Hover shows the name and shortcut; small badges show
  dropped sessions, failed intents, busy AI/API and unsaved editor changes.
- **One side panel** holds Editor, API and AI as tabs. Switching tabs or
  closing the panel keeps your work (unsaved editor text, a half-built API
  request, the chat). It can be maximized; Ctrl/⌘+Shift+E/A/I switch to a
  tab or close it. Editor, API and AI can no longer be open side by side.
- **Simpler title bar**: the brand, a "Search or run a command…" field that
  opens the command palette, and Connect. Split view, Multi-send and Snippets
  moved to the right end of the tab strip.
- **Settings** are grouped by task (Appearance · Terminal · Connections &
  Security · Automation · AI & MCP · Integrations · Backup & Reset) and have a
  search box; Help and Settings share one window style.
- Network Intent's header no longer wraps its buttons onto two lines.
- Documentation screenshots show the new layout and name.

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
- Split view acts on the pane you're in: clicking a pane makes it the active
  one, so close / find / snippets / logging no longer hit the first pane.
- Bulk Runner and multi-send are safe by default: they target only the
  devices you pick (not every connected session, local shells or consoles),
  confirm risky commands naming the devices, turn paging off so output isn't
  cut at `--More--`, and outline every terminal a multi-send will type into.
  Snippets insert without pressing Enter (Shift+click runs), support
  `{{name}}` prompts, and ask before deleting.
- Closing a connected session asks first (setting); red "danger" dialogs
  focus Cancel; a key pressed in a dialog no longer reaches the device
  behind it.
- The password dialog has a Username field and shows "Access denied
  (attempt N)" inline; the vault prompt names the waiting hosts and offers
  "Skip — type the device password".
- Config Editor: `no shutdown` no longer flagged as dangerous, the send
  preview compares against the right device, sending stops at the first
  device error, and templates include `configure terminal` / `configure`.
- Editing a saved host while its tab is connected no longer relabels the
  live tab as the new address.
- Toasts moved top-right (off the AI send box), fold repeats, and only
  report connects/disconnects for tabs you can't see; dim hint text meets
  4.5:1 contrast in both themes; light mode gets a light backdrop.
- Opening several side panels can no longer squeeze the terminal to
  nothing (panels shrink or the oldest closes); panel widths are remembered.
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
