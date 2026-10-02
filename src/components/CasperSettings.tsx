// Settings → AI & MCP, when the provider is Casper: the command, a check,
// and the working folder.

import { useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { open as openDialog } from '@tauri-apps/api/dialog';
import { useSettingsStore } from '../store/settingsStore';
import { notify } from '../store/toastStore';
import type { CasperCheck } from '../types';
import { plainCliError } from '../utils/cliPrompt';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

/** A check result belongs to one command and one folder. */
const checkKey = (command: string, folder: string) => `${command}\u0000${folder}`;

function runCheck(command: string, workFolder: string, logFolder: string): Promise<CasperCheck> {
  return invoke<CasperCheck>('ai_casper_check', {
    command,
    workFolder: workFolder || null,
    logFolder: logFolder || null,
  });
}

export default function CasperSettings() {
  const casperCommand = useSettingsStore((s) => s.casperCommand);
  const casperWorkFolder = useSettingsStore((s) => s.casperWorkFolder);
  const sessionLogDir = useSettingsStore((s) => s.sessionLogDir);
  const setCasperCommand = useSettingsStore((s) => s.setCasperCommand);
  const setCasperWorkFolder = useSettingsStore((s) => s.setCasperWorkFolder);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ key: string; check: CasperCheck } | null>(null);
  // A result for another command or folder is out of date: it isn't shown.
  const shown = result && result.key === checkKey(casperCommand, casperWorkFolder) ? result.check : null;

  const check = async () => {
    const key = checkKey(casperCommand, casperWorkFolder);
    setChecking(true);
    try {
      setResult({ key, check: await runCheck(casperCommand, casperWorkFolder, sessionLogDir) });
    } catch (e) {
      setResult({
        key,
        check: {
          ok: false,
          version: null,
          workFolder: casperWorkFolder,
          message: plainCliError(e),
          folderOk: true,
          folderMessage: null,
          warnings: [],
        },
      });
    } finally {
      setChecking(false);
    }
  };

  const chooseFolder = async () => {
    let picked: string | string[] | null;
    try {
      picked = await openDialog({
        title: "Choose Casper's working folder",
        directory: true,
        multiple: false,
        defaultPath: casperWorkFolder || undefined,
      });
    } catch (e) {
      notify.warning('Could not choose a folder', String(e));
      return;
    }
    if (typeof picked !== 'string') return;
    setChecking(true);
    try {
      const found = await runCheck(casperCommand, picked, sessionLogDir);
      if (!found.folderOk) {
        notify.warning("Can't use that folder", found.folderMessage ?? undefined);
        return;
      }
      setCasperWorkFolder(picked);
      setResult({ key: checkKey(casperCommand, picked), check: found });
    } catch (e) {
      notify.warning("Can't use that folder", plainCliError(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="casper-command" className="block text-xs text-[var(--text-secondary)] mb-1.5">
          Casper command
        </label>
        <input
          id="casper-command"
          type="text"
          value={casperCommand}
          onChange={(e) => setCasperCommand(e.target.value)}
          placeholder="casper"
          spellCheck={false}
          className="w-full h-8 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
        />
        <p className="text-[10px] text-[var(--text-muted)] mt-1">
          Runs Casper on this computer with your question.{' '}
          <span className="text-[var(--accent-success)]">No API key needed</span>: Casper uses its own sign-in. You can
          add <code className="text-[var(--text-primary)]">--model</code>,{' '}
          <code className="text-[var(--text-primary)]">--effort</code>,{' '}
          <code className="text-[var(--text-primary)]">--max-turns</code> or{' '}
          <code className="text-[var(--text-primary)]">--verify</code>. GreenCLI adds{' '}
          <code className="text-[var(--text-primary)]">--json</code>, sends your question separately, and never turns
          off Casper&apos;s sandbox. Unless you set them, it also adds{' '}
          <code className="text-[var(--text-primary)]">--no-verify</code> and{' '}
          <code className="text-[var(--text-primary)]">--max-turns 20</code>.
        </p>
        <p className="text-[10px] text-[var(--text-muted)] mt-1">
          Casper runs its own commands in a sandbox, and those can reach this computer&apos;s ports. So Casper
          won&apos;t start while a port forward is open or a web MCP server on this computer is set up in MCP Servers.
          While Casper is answering, GreenCLI won&apos;t open a port forward or connect any web MCP server. Casper
          keeps a copy of each question and answer in ~/.casper.
        </p>
        <p className="text-[10px] text-[var(--accent-warning)] mt-1">
          Casper can read files outside its folder. It keeps only a short list of private places from the AI (like
          ~/.ssh), and GreenCLI&apos;s own files are not on that list: your AI keys, MCP logins and session logs. Ask
          Casper only about text you trust, since words hidden in a config or log could ask it to read those files.
        </p>
      </div>

      <div>
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className="px-3 h-8 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-xs text-[var(--text-primary)] disabled:opacity-60"
        >
          {checking ? 'Checking…' : 'Check Casper'}
        </button>
        {shown && (
          <div role="status" className="mt-2 space-y-1">
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed">
              {shown.ok ? (
                <CheckCircle2 size={12} className="mt-0.5 flex-shrink-0 text-[var(--accent-success)]" />
              ) : (
                <AlertCircle size={12} className="mt-0.5 flex-shrink-0 text-[var(--accent-warning)]" />
              )}
              <span className="text-[var(--text-primary)]">{shown.message}</span>
            </p>
            {shown.warnings.map((w) => (
              <p key={w} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--accent-warning)]">
                <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                <span>{w}</span>
              </p>
            ))}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Working folder</label>
        <div className="flex items-center gap-2">
          <div
            className="flex-1 min-w-0 h-8 px-2.5 flex items-center rounded border border-[var(--border)] bg-[var(--bg-primary)] text-xs font-mono truncate"
            title={casperWorkFolder || 'A fresh folder for each question (default)'}
          >
            {casperWorkFolder ? (
              <span className="truncate text-[var(--text-primary)]">{casperWorkFolder}</span>
            ) : (
              <span className="text-[var(--text-muted)]">A fresh folder for each question (default)</span>
            )}
          </div>
          {isTauri && (
            <button
              type="button"
              onClick={chooseFolder}
              disabled={checking}
              className="px-3 h-8 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] text-xs text-[var(--text-primary)] flex-shrink-0 disabled:opacity-60"
            >
              Choose…
            </button>
          )}
          {casperWorkFolder && (
            <button
              type="button"
              onClick={() => setCasperWorkFolder('')}
              className="px-2 h-8 rounded text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] flex-shrink-0"
              title="Give Casper a fresh, empty folder for each question"
            >
              Use GreenCLI&apos;s folder
            </button>
          )}
        </div>
        <p className="text-[10px] text-[var(--text-muted)] mt-1">
          By default Casper gets a fresh, empty folder for each question, and GreenCLI deletes it afterwards. If you
          pick a folder, Casper reads and writes files there and follows instruction files it finds there or above it
          (.casper/rules.md, AGENTS.md, CLAUDE.md). Your home folder and GreenCLI&apos;s own folders can&apos;t be used.
        </p>
      </div>
    </div>
  );
}
