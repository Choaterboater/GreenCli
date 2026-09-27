import { useEffect, useRef, useState } from 'react';
import { Radio } from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { askConfirm } from '../store/dialogStore';
import { notify } from '../store/toastStore';
import { isRiskyCommand, listNames } from '../utils/commandRisk';
import {
  configModeSummary,
  isMultiSendTarget,
  multiSendTargetSessions,
  pushHistory,
  stepHistory,
} from '../utils/multiSend';
import { tabLabel } from '../utils/tabs';
import { Session } from '../types';

// Sent commands, newest last. Module-level so closing and reopening the bar
// keeps them; memory only — sent lines can carry secrets and never hit disk.
let sentHistory: string[] = [];
const rememberSent = (text: string) => {
  sentHistory = pushHistory(sentHistory, text);
};

// Tab labels, so two sessions to one host ("core-sw-01 (2)") can be told apart.
const sessionName = (s: Session) => tabLabel(s);

// Multi-send bar: type once into several sessions. Targets default to the
// chosen sessions (starting with the active one), not "all" — with "all", a
// production box connected later would silently join the next send.
export default function MultiSendBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const targetsState = useSessionStore((s) => s.multiSendTargets);
  const setTargets = useSessionStore((s) => s.setMultiSendTargets);

  const [input, setInput] = useState('');
  // Send the text as typed, without Enter (y/n answers, `?`, pager keys).
  const [noEnter, setNoEnter] = useState(false);
  const [histPos, setHistPos] = useState<number | null>(null);
  const draftRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);

  const connected = sessions.filter((s) => s.connected);
  const targets = multiSendTargetSessions(sessions, targetsState);
  const n = targets.length;
  const configNote = configModeSummary(targets);
  const plural = (k: number) => `${k} session${k === 1 ? '' : 's'}`;

  const activeConnectedIds = () => {
    const { sessions: all, activeSessionId } = useSessionStore.getState();
    return all.some((s) => s.sessionId === activeSessionId && s.connected) ? [activeSessionId as string] : [];
  };

  // On open: if nothing from an earlier selection is still connected, start
  // from the active session so the first send does the obvious thing.
  useEffect(() => {
    const { sessions: all, multiSendTargets } = useSessionStore.getState();
    if (multiSendTargets.mode !== 'selected') return;
    if (all.some((s) => isMultiSendTarget(s, multiSendTargets))) return;
    setTargets({ mode: 'selected', ids: activeConnectedIds() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchMode = (mode: 'all' | 'selected') => {
    const ids = mode === 'selected' && targetsState.ids.length === 0 ? activeConnectedIds() : targetsState.ids;
    setTargets({ mode, ids });
  };

  const toggleTarget = (id: string) =>
    setTargets({
      mode: 'selected',
      ids: targetsState.ids.includes(id) ? targetsState.ids.filter((x) => x !== id) : [...targetsState.ids, id],
    });

  const sendRaw = (list: Session[], data: string) =>
    list.forEach((s) => invoke('send_data', { sessionId: s.sessionId, data }).catch(() => {}));

  const send = async () => {
    const text = input;
    // With "No Enter" a lone space is meaningful (next pager page).
    if (noEnter ? text.length === 0 : !text.trim()) return;
    const list = targets;
    if (list.length === 0) {
      notify.warning(
        'Nothing to send',
        targetsState.mode === 'selected'
          ? 'No target sessions are selected (or none are connected).'
          : 'No sessions are currently connected.'
      );
      return;
    }
    if (list.length > 1 && isRiskyCommand(text)) {
      const ok = await askConfirm({
        title: `Send "${text.trim()}" to ${plural(list.length)}?`,
        message: `This looks like it changes device state. Sessions: ${listNames(list.map(sessionName))}.`,
        confirmLabel: `Send to ${list.length}`,
        danger: true,
      });
      inputRef.current?.focus();
      if (!ok) return;
    }
    // Skip any that dropped while the confirm was open.
    const live = list.filter((s) => useSessionStore.getState().sessions.find((x) => x.sessionId === s.sessionId)?.connected);
    sendRaw(live, noEnter ? text : text + '\r');
    notify.success('Multi-send', `Sent to ${plural(live.length)}${noEnter ? ' (no Enter)' : ''}.`);
    rememberSent(text);
    setHistPos(null);
    setInput('');
  };

  const interruptAll = () => {
    if (n === 0) return;
    sendRaw(targets, '\x03');
    notify.success('Multi-send', `Sent Ctrl+C to ${plural(n)}.`);
    inputRef.current?.focus();
  };

  const recall = (dir: 'up' | 'down') => {
    const next = stepHistory(sentHistory, histPos, dir);
    if (next === histPos) return;
    if (histPos === null) draftRef.current = input; // keep what was being typed
    setHistPos(next);
    setInput(next === null ? draftRef.current : sentHistory[next]);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 bg-[var(--accent-2-soft)] border-b border-[var(--accent-2)]/40">
      <Radio size={12} className="text-[var(--accent-2)] flex-shrink-0" />
      <span className="text-[10px] text-[var(--accent-2)] uppercase font-semibold tracking-wide flex-shrink-0">
        Multi-send
      </span>
      {/* Selected / All toggle */}
      <div className="flex items-center rounded-md overflow-hidden border border-[var(--border)] flex-shrink-0">
        {(['selected', 'all'] as const).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            title={m === 'all' ? 'Every connected session, including ones connected later' : 'Only the sessions ticked here'}
            className={`px-2 py-0.5 text-[10px] capitalize transition-colors ${
              targetsState.mode === m
                ? 'bg-[var(--accent-2)] text-[var(--accent-2-fg)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      {/* Target chips */}
      {connected.length === 0 ? (
        <span className="text-[10px] text-[var(--text-muted)]">No connected sessions</span>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {connected.map((s) => {
            const on = isMultiSendTarget(s, targetsState);
            const all = targetsState.mode === 'all';
            return (
              <button
                key={s.sessionId}
                onClick={() => !all && toggleTarget(s.sessionId)}
                disabled={all}
                title={all ? 'All connected sessions' : on ? 'Click to exclude' : 'Click to include'}
                className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                  on
                    ? 'bg-[var(--accent-2-soft)] border-[var(--accent-2)] text-[var(--accent-2)]'
                    : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                } ${all ? 'cursor-default' : 'cursor-pointer'}`}
              >
                {on ? '✓ ' : ''}
                {sessionName(s)}
                {s.configMode && (
                  <span
                    className="inline-block w-1.5 h-1.5 ml-1 rounded-full align-middle"
                    style={{ background: 'var(--config-mode)' }}
                    title="In config mode"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
      {configNote && (
        <span
          className="text-[10px] font-medium flex-shrink-0"
          style={{ color: 'var(--config-mode)' }}
          title="Read from each device's prompt. A command meant for one mode may fail — or do something else — in the other."
        >
          {configNote}
        </span>
      )}
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          setHistPos(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            void send();
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault();
            recall(e.key === 'ArrowUp' ? 'up' : 'down');
          }
        }}
        spellCheck={false}
        placeholder={
          n === 0
            ? 'Pick at least one session…'
            : `${noEnter ? 'Text' : 'Command'} to send to ${plural(n)}… (↑/↓ for history)`
        }
        className="flex-1 min-w-[140px] h-7 px-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-2)]"
      />
      <button
        onClick={() => setNoEnter((v) => !v)}
        aria-pressed={noEnter}
        title="Send the text without pressing Enter — for y/n answers, ?, or a space to page"
        className={`px-2 py-0.5 text-[10px] rounded border transition-colors flex-shrink-0 ${
          noEnter
            ? 'bg-[var(--accent-2)] border-[var(--accent-2)] text-[var(--accent-2-fg)]'
            : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
        }`}
      >
        No Enter
      </button>
      <button
        onClick={interruptAll}
        disabled={n === 0}
        title={`Send Ctrl+C (interrupt) to ${plural(n)}`}
        className="px-2 py-0.5 text-[10px] rounded border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 transition-colors flex-shrink-0"
      >
        Ctrl+C
      </button>
      <button
        onClick={() => void send()}
        disabled={n === 0}
        className="px-2.5 py-1 text-xs bg-[var(--accent-2)] hover:brightness-110 disabled:opacity-40 text-[var(--accent-2-fg)] rounded transition-colors flex-shrink-0"
      >
        Send to {n}
      </button>
    </div>
  );
}
