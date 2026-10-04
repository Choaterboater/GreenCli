import { describe, expect, it } from 'vitest';
import { importDialog, importDoneText, pickDialog } from './mcpImport';
import type { McpImportItem, McpImportPreview } from './mcpTypes';

const item = (over: Partial<McpImportItem>): McpImportItem => ({
  id: 'x',
  name: 'x',
  source: 'Casper',
  transport: 'stdio',
  preset: null,
  pins: { kind: 'none' },
  needs: [],
  notes: [],
  runs: 'uvx x',
  ...over,
});

const PREVIEW: McpImportPreview = {
  token: 't',
  items: [
    item({
      id: 'centralmcp',
      name: 'centralmcp',
      preset: 'Central',
      pins: { kind: 'pinned', shown: ['CENTRALMCP_READONLY=1'], confirmed: false },
      runs: 'uvx centralmcp',
    }),
    item({
      id: 'junos',
      name: 'junos',
      source: 'Claude Code',
      preset: 'Junos',
      pins: { kind: 'cannot-pin', reason: 'it has no read-only setting' },
      runs: 'python3 /opt/junos/jmcp.py',
    }),
    item({ id: 'github', name: 'github', source: 'VS Code', needs: ['GITHUB_TOKEN'], runs: 'npx github' }),
    item({ id: 'lab', name: 'lab', notes: ['it was turned off there'], runs: 'netbox-mcp' }),
  ],
  skipped: [
    { name: 'greencli', source: 'Claude Code', reason: "this is GreenCLI's own server" },
    { name: 'netbox', source: 'Casper', reason: 'a server with this name is already in GreenCLI' },
  ],
  problems: ['Skipped ~/.claude.json: it is larger than 32 MB.'],
};

describe('importDialog', () => {
  it('offers Not now first, then Import all and Pick which', () => {
    const d = importDialog(PREVIEW);
    expect(d.title).toBe('Use MCP servers you already set up?');
    expect(d.choices.map((c) => c.value)).toEqual(['no', 'all', 'pick']);
    expect(d.choices.map((c) => c.label)).toEqual(['Not now', 'Import all', 'Pick which…']);
    expect(d.choices[0].tone).toBe('plain');
    expect(d.choices[1].tone).toBe('accent');
  });

  it('counts servers and names the places they came from', () => {
    expect(importDialog(PREVIEW).message).toBe(
      'GreenCLI found 4 servers in Casper, Claude Code and VS Code. Each comes in with writes off and is not started.',
    );
    const one = importDialog({ ...PREVIEW, items: [PREVIEW.items[0]] });
    expect(one.message).toBe('GreenCLI found 1 server in Casper. It comes in with writes off and is not started.');
    // One server: no Pick which.
    expect(one.choices.map((c) => c.label)).toEqual(['Not now', 'Import it']);
  });

  it('has one note per server and per skip, never a value', () => {
    const notes = importDialog(PREVIEW).notes;
    expect(notes).toEqual([
      'centralmcp (Casper): read-only setting added at Connect: CENTRALMCP_READONLY=1',
      'junos (Claude Code): Junos, it has no read-only setting',
      'github (VS Code): needs GITHUB_TOKEN; add it with Edit',
      'lab (Casper): it was turned off there',
      "greencli (Claude Code): skipped, this is GreenCLI's own server",
      'netbox (Casper): skipped, a server with this name is already in GreenCLI',
      'Skipped ~/.claude.json: it is larger than 32 MB.',
    ]);
  });

  it('shows what each server runs in the details box', () => {
    const d = importDialog(PREVIEW);
    expect(d.detailsLabel).toBe('What each one runs');
    expect(d.details).toBe(
      'centralmcp: uvx centralmcp\njunos: python3 /opt/junos/jmcp.py\ngithub: npx github\nlab: netbox-mcp',
    );
  });
});

describe('pickDialog', () => {
  it('asks Skip first, then Import, for one server', () => {
    const d = pickDialog(PREVIEW.items[2], 2, 4);
    expect(d.title).toBe('Import github?');
    expect(d.message).toBe('From VS Code (3 of 4). It comes in with writes off and is not started.');
    expect(d.choices.map((c) => [c.value, c.label])).toEqual([
      ['skip', 'Skip'],
      ['import', 'Import'],
    ]);
    expect(d.notes).toEqual(['needs GITHUB_TOKEN; add it with Edit']);
    expect(d.details).toBe('npx github');
  });
});

describe('importDoneText', () => {
  it('says how many came in, what needs a value and what was skipped', () => {
    const done = importDoneText({ added: ['github', 'junos'], skipped: [['lab', 'already in GreenCLI as lab2']] }, PREVIEW.items);
    expect(done.title).toBe('2 MCP servers imported');
    expect(done.detail).toBe('Writes are off. Click Connect when you want one.');
    expect(done.needs).toEqual(['github needs GITHUB_TOKEN. Click Edit to add it.']);
    expect(done.skipped).toEqual(['lab: already in GreenCLI as lab2']);
    expect(importDoneText({ added: ['junos'], skipped: [] }, PREVIEW.items).title).toBe('1 MCP server imported');
  });
});
