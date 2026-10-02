# Screenshots

GreenCLI 2.0 with made-up demo data: no real devices, addresses, people or keys.
Each picture is the 1440 x 900 window at 2x (2880 x 1800 pixels). 08 is cropped to the Settings box.

- `01-main-window.png`: Main window: an AOS-CX session with show output, saved hosts in folders on the left.
- `02-config-editor.png`: Config Editor: an Aruba CX change with squiggles, the Problems list and where Send goes.
- `03-ai-review-diff.png`: Config Editor: an AI fix shown as a diff to Apply or Discard. Secrets were put back.
- `04-editor-folder-view.png`: Config Editor: a folder of configs as a tree, next to the open file.
- `05-ai-assistant.png`: AI Assistant: it ran a show command; the keys in its output show as `<secret hidden>`.
- `06-mcp-approval.png`: The approval box: an MCP tool that can delete, restart or disconnect things, with its full arguments.
- `07-settings-mcp-servers.png`: Settings, MCP Servers: writes off, read-only settings, greencli-mcp, and Export for Casper or Claude.
- `08-settings-updates.png`: Settings, Updates: version 2.0.0, "You have the latest version." and Check once a day.
- `09-change-jobs.png`: Change Jobs: the dry run of a VLAN change on four switches, with the rollback timer.
- `10-settings-ai.png`: Settings, AI: the provider and model, and "Saved in macOS Keychain." under the API key.
- `11-network-intent.png`: Network Intent: checks of the state you expect, with one problem found on two switches.

## Take them again

```bash
npx playwright install chromium   # once
npm run build
npm run screenshots
```

This writes all the pictures and this file. `npm run screenshots -- --only 03` takes just one,
and `--out <folder>` saves them somewhere else. The demo hosts, output and AI answers are in
`scripts/screenshots/`. Nothing talks to a real device or AI.
