// The shot list: one entry per PNG. `run` drives the app (talking to the
// demo backend) to the screen to show; the script then takes the picture.
// `about` is the file's line in docs/screenshots/README.md. `storage` is
// seeded before the app loads (seedStorage in demo-data.mjs), `demo` swaps
// parts of the demo data, `clip` crops the picture, and `keepMouse` keeps a
// hover on screen.

import { coreSw1Narrow, devices } from './demo-data.mjs';

const PANEL_WIDTH = 'greencli-side-panel-width';

/** Double-click a saved host in the sidebar, and wait for its output. */
async function openHost(page, name) {
  await page.locator('[draggable="true"]', { hasText: name }).first().dblclick();
  await page.waitForTimeout(600);
}

/** A button in the activity bar (left edge), by its label. */
async function activity(page, label) {
  await page.locator(`nav[aria-label="Activity bar"] button[aria-label="${label}"]`).click();
  await page.waitForTimeout(400);
}

/** The Config Editor with the demo change file open. */
async function editorWithFile(page) {
  await activity(page, 'Config Editor');
  await page.locator('#side-panel-editor button[aria-label="Open file"]').click();
  await page.locator('#side-panel-editor .view-lines').first().waitFor();
  await page.waitForTimeout(1200); // Monaco colors, squiggles, problems
}

/** Type a question into the AI panel and send it. */
async function askAi(page, question) {
  const box = page.locator('#side-panel-ai textarea');
  await box.fill(question);
  await box.press('Enter');
}

/** Settings, on one group of the left rail. */
async function settings(page, group) {
  await activity(page, 'Settings');
  await page.getByRole('button', { name: group, exact: true }).first().click();
  await page.waitForTimeout(500);
}

export const shots = [
  {
    file: '01-main-window.png',
    about: 'Main window: an AOS-CX session with show output, saved hosts in folders on the left.',
    async run(page) {
      await openHost(page, 'access-sw3');
      await openHost(page, 'edge-mx1');
      await openHost(page, 'core-sw1');
    },
  },
  {
    file: '02-config-editor.png',
    keepMouse: true,
    about: 'Config Editor: an Aruba CX change with squiggles, the Problems list and where Send goes.',
    storage: { local: { [PANEL_WIDTH]: '840' } },
    demo: { devices: { ...devices, '192.0.2.11': { ...devices['192.0.2.11'], banner: coreSw1Narrow } } },
    async run(page) {
      await openHost(page, 'core-sw1');
      await activity(page, 'Sessions'); // hide the sidebar: more room for the editor
      await editorWithFile(page);
      await page.locator('#side-panel-editor button[aria-label^="Problems:"]').click();
      await page.waitForTimeout(400);
      // Hover a risky line so its problem card (with a quick fix) shows.
      await page.locator('#side-panel-editor .view-line', { hasText: 'no vlan 99' }).first().hover({
        position: { x: 30, y: 8 },
      });
      await page.waitForTimeout(1200);
    },
  },
  {
    file: '03-ai-review-diff.png',
    about: 'Config Editor: an AI fix shown as a diff to Apply or Discard. Secrets were put back.',
    storage: { local: { [PANEL_WIDTH]: '840' } },
    async run(page) {
      await openHost(page, 'core-sw1');
      await activity(page, 'Sessions');
      await editorWithFile(page);
      await page.locator('#side-panel-editor button', { hasText: 'Ask AI' }).click();
      await page.getByRole('button', { name: 'Fix the problems found' }).click();
      const review = page.locator('#side-panel-ai button', { hasText: 'Review in Editor' }).first();
      await review.waitFor({ timeout: 15000 });
      await page.waitForTimeout(600);
      await review.click();
      await page.locator('#side-panel-editor .monaco-diff-editor').first().waitFor();
      await page.locator('button[aria-label="Maximize side panel"]').click();
      await page.waitForTimeout(1500);
    },
  },
  {
    file: '04-editor-folder-view.png',
    about: 'Config Editor: a folder of configs as a tree, next to the open file.',
    storage: { local: { [PANEL_WIDTH]: '840' } },
    async run(page) {
      await openHost(page, 'edge-mx1');
      await activity(page, 'Sessions');
      await activity(page, 'Config Editor');
      await page.locator('#side-panel-editor button[aria-label="Open a folder"]').click();
      const tree = page.locator('nav[aria-label="Folder"]');
      await tree.waitFor();
      for (const dir of ['core', 'edge', 'campus-a']) {
        await tree.getByRole('button', { name: dir, exact: true }).click();
      }
      await tree.getByRole('button', { name: 'access-base.cfg' }).click();
      await page.waitForTimeout(500);
      await tree.getByRole('button', { name: 'edge-mx1.txt' }).click();
      await page.locator('#side-panel-editor .view-lines').first().waitFor();
      await page.waitForTimeout(1200);
    },
  },
  {
    file: '05-ai-assistant.png',
    about: 'AI Assistant: it ran a show command; the keys in its output show as `<secret hidden>`.',
    storage: { local: { [PANEL_WIDTH]: '580' } },
    async run(page) {
      await openHost(page, 'core-sw1');
      await activity(page, 'Sessions');
      await activity(page, 'AI Assistant');
      await askAi(page, 'Check the RADIUS and SNMP setup on this switch. Anything wrong?');
      const row = page.locator('#side-panel-ai button', { hasText: 'show running-config' }).first();
      await row.waitFor({ timeout: 20000 });
      await page.locator('#side-panel-ai', { hasText: 'What I would change' }).waitFor({ timeout: 20000 });
      await row.click();
      await page.waitForTimeout(600);
    },
  },
  {
    file: '06-mcp-approval.png',
    about: 'The approval box: an MCP tool that can delete, restart or disconnect things, with its full arguments.',
    storage: { settings: { aiUseMcp: true }, local: { [PANEL_WIDTH]: '600' } },
    async run(page) {
      await openHost(page, 'access-sw3');
      await activity(page, 'Sessions');
      await activity(page, 'AI Assistant');
      await askAi(page, 'The phone on 1/1/12 is stuck in a PoE fault. Please bounce the port.');
      await page.getByText('This tool can delete, restart or disconnect things').waitFor({ timeout: 20000 });
      await page.waitForTimeout(600);
    },
  },
  {
    file: '07-settings-mcp-servers.png',
    about: 'Settings, MCP Servers: writes off, read-only settings, greencli-mcp, and Export for Casper or Claude.',
    async run(page) {
      await openHost(page, 'core-sw1');
      await settings(page, 'AI & MCP');
      await page.getByRole('heading', { name: 'MCP Servers' }).waitFor();
      await page.waitForTimeout(800);
      await page.getByRole('heading', { name: 'MCP Servers' }).evaluate((h) => h.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(400);
    },
  },
  {
    file: '08-settings-updates.png',
    about: 'Settings, Updates: version 2.0.0, "You have the latest version." and Check once a day.',
    async run(page) {
      await openHost(page, 'core-sw1');
      await settings(page, 'Updates');
      await page.getByRole('button', { name: 'Check for updates' }).click();
      await page.getByText('You have the latest version.').waitFor();
      await page.waitForTimeout(300);
    },
    // The Updates page is short: keep the top of the Settings box only.
    async clip(page) {
      const box = await page.getByRole('dialog').boundingBox();
      return { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: 440 };
    },
  },
  {
    file: '09-change-jobs.png',
    about: 'Change Jobs: the dry run of a VLAN change on four switches, with the rollback timer.',
    async run(page) {
      await openHost(page, 'core-sw1');
      await activity(page, 'Change Jobs');
      const job = page.getByRole('dialog');
      await job.getByRole('button', { name: 'access', exact: true }).click();
      await page.getByPlaceholder(/^vlan \$\{vlan\}/).fill(
        'vlan ${vlan}\n    name ${vlan_name}\ninterface lag 1\n    vlan trunk allowed ${vlan}'
      );
      await page.getByPlaceholder(/^show version/).fill('show version => 10.13');
      await page.getByPlaceholder(/^show vlan \$\{vlan\}/).fill('show vlan ${vlan} => ${vlan_name}');
      await page
        .getByPlaceholder(/^device,vlan,vlan_name/)
        .fill('device,vlan,vlan_name\naccess-sw1,50,CAMERAS\naccess-sw2,50,CAMERAS\naccess-sw3,50,CAMERAS\naccess-sw4,50,CAMERAS');
      await job.getByRole('button', { name: 'Dry run', exact: true }).last().click();
      await page.getByText('Dry run — nothing has been sent.').waitFor();
      // Fold all but the canary, so all four devices fit (the AOS-S one has no rollback timer).
      for (const name of ['access-sw2', 'access-sw3', 'access-sw4']) {
        await job.locator('div.rounded-lg.border', { hasText: name }).first().locator('button').first().click();
      }
      await job.getByText('Dry run — nothing has been sent.').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(500);
    },
  },
  {
    file: '10-settings-ai.png',
    about: 'Settings, AI: the provider and model, and "Saved in macOS Keychain." under the API key.',
    storage: { settings: { aiUseMcp: true } },
    async run(page) {
      await openHost(page, 'core-sw1');
      await settings(page, 'AI & MCP');
    },
  },
  {
    file: '11-network-intent.png',
    about: 'Network Intent: checks of the state you expect, with one problem found on two switches.',
    async run(page) {
      await openHost(page, 'core-sw1');
      await activity(page, 'Network Intent');
      await page.getByText('No SNMP v2c communities').waitFor();
      const row = page.locator('div.border-b', { hasText: 'No SNMP v2c communities' }).first();
      await row.locator('button').first().click();
      await page.waitForTimeout(500);
    },
  },
];
