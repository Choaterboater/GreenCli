// A fake GreenCLI backend for the screenshot script. It runs INSIDE the page
// (Playwright's addInitScript), before the app loads, and answers the app's
// Tauri calls with the demo data from demo-data.mjs. Nothing here talks to a
// real device or AI: every host, address, key and answer is made up.
//
// The page script can reach it as window.__demo:
//   __demo.emit(event, payload)    send a backend event
//   __demo.print(sessionId, text)  write text into a terminal tab
//   __demo.calls                   every command the app sent (for debugging)

export function installDemoBackend(D) {
  const callbacks = new Map();
  const listeners = new Map(); // event name -> [callback id]
  let nextId = 1;
  const calls = [];
  const hostOf = new Map(); // session id -> host address
  const output = new Map(); // session id -> everything printed so far
  const typed = new Map(); // session id -> the line being typed

  const runCallback = (id, data) => {
    const cb = callbacks.get(id);
    if (cb) cb(data);
  };
  const emit = (event, payload) => {
    for (const id of listeners.get(event) || []) runCallback(id, { event, id, payload });
  };
  const enc = new TextEncoder();
  const print = (sessionId, text) => {
    output.set(sessionId, (output.get(sessionId) || '') + text);
    emit('terminal_data', { sessionId, data: Array.from(enc.encode(text)) });
  };
  const later = (ms, fn) => setTimeout(fn, ms);
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

  // A typed line reached the "device": echo it, answer, show the prompt again.
  function runLine(sessionId, line) {
    const host = hostOf.get(sessionId);
    const dev = D.devices[host] || D.devices.default;
    const answer = dev.commands[line.trim()];
    let text = line + '\r\n';
    if (answer) text += crlf(answer.replace(/\n+$/, '')) + '\r\n\r\n';
    print(sessionId, text + dev.prompt);
  }

  // ── The scripted AI (Anthropic-style stream) ──
  function textOf(content) {
    if (typeof content === 'string') return content;
    return (content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
  function aiReply(body) {
    const messages = body.messages || [];
    const firstUser = messages.find((m) => m.role === 'user');
    const question = textOf(firstUser && firstUser.content);
    const last = messages[messages.length - 1];
    const afterTool = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    const script = D.ai.find((s) => new RegExp(s.match, 'i').test(question)) || D.aiFallback;
    if (script.fix) {
      // "Fix the problems": answer with the tab's own lines, fixed.
      const m = /```([\w-]*)\n([\s\S]*?)\n```/.exec(question);
      let code = m ? m[2] : '';
      for (const [from, to] of script.fix) code = code.split(from).join(to);
      return { blocks: [{ type: 'text', text: script.text.replace('{code}', '```' + (m ? m[1] : '') + '\n' + code + '\n```') }] };
    }
    if (script.tool && !afterTool) {
      const tool = (body.tools || []).find((t) => t.name === script.tool.name || t.name.endsWith('__' + script.tool.name));
      return {
        blocks: [
          { type: 'text', text: script.before },
          { type: 'tool_use', id: 'toolu_demo_' + nextId++, name: tool ? tool.name : script.tool.name, input: script.tool.input },
        ],
        stop: 'tool_use',
      };
    }
    return { blocks: [{ type: 'text', text: script.text }] };
  }
  function streamAi(streamId, body) {
    const { blocks, stop } = aiReply(body);
    const events = [];
    blocks.forEach((b, index) => {
      if (b.type === 'text') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        const words = b.text.match(/[\s\S]{1,40}/g) || [];
        for (const w of words) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: w } });
      } else {
        events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name } });
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
        });
      }
      events.push({ type: 'content_block_stop', index });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: stop || 'end_turn' } });
    events.forEach((ev, i) => later(80 + i * 6, () => emit('ai_chunk', { streamId, data: JSON.stringify(ev) })));
    later(120 + events.length * 6, () => emit('ai_done', { streamId }));
  }

  function handle(cmd, args) {
    args = args || {};
    switch (cmd) {
      // ── Tauri plugins ──
      case 'plugin:event|listen': {
        const list = listeners.get(args.event) || [];
        list.push(args.handler);
        listeners.set(args.event, list);
        return args.handler;
      }
      case 'plugin:event|unlisten': {
        const list = listeners.get(args.event) || [];
        listeners.set(args.event, list.filter((h) => h !== args.eventId));
        return null;
      }
      case 'plugin:event|emit':
        emit(args.event, args.payload);
        return null;
      case 'plugin:dialog|open':
        return args.options && args.options.directory ? D.folder.root : D.openFile;
      case 'plugin:dialog|save':
        return D.saveFile;

      // ── Sessions ──
      case 'list_folders':
        return clone(D.folders);
      case 'connect': {
        const cfg = args.config || {};
        hostOf.set(cfg.id, cfg.host);
        const dev = D.devices[cfg.host] || D.devices.default;
        later(150, () => print(cfg.id, crlf(dev.banner || '') + dev.prompt));
        return { success: true };
      }
      case 'get_terminal_output':
        return output.get(args.sessionId) || '';
      case 'send_data': {
        const sid = args.sessionId;
        if (!hostOf.has(sid)) return null;
        let line = (typed.get(sid) || '') + String(args.data || '');
        let cut = line.search(/[\r\n]/);
        while (cut !== -1) {
          const done = line.slice(0, cut);
          line = line.slice(cut + 1).replace(/^\n/, '');
          later(60, () => runLine(sid, done));
          cut = line.search(/[\r\n]/);
        }
        typed.set(sid, line);
        return null;
      }

      // ── Keys, vault, updates ──
      case 'vault_is_unlocked':
      case 'vault_is_initialized':
      case 'ai_has_key':
        return true;
      case 'secret_store_status':
        return { kind: 'credential-manager', leftoverFiles: [], movePending: false };
      case 'update_status':
        return clone(D.update);
      case 'update_check':
        return new Promise((r) => later(400, () => r(null)));

      // ── Editor files ──
      case 'read_file_text':
      case 'read_folder_file': {
        const name = String(args.path || '').split(/[\\/]/).pop();
        return D.files[name] != null ? D.files[name] : '';
      }
      case 'list_folder':
        return clone(D.folder);

      // ── AI ──
      case 'ai_chat_stream':
        streamAi(args.streamId, (args.request || {}).body || {});
        return null;

      // ── MCP ──
      case 'mcp_list_servers':
        return clone(D.mcp.servers);
      case 'mcp_status':
        return clone(D.mcp.status);
      case 'mcp_all_tools':
        return clone(D.mcp.tools);
      case 'mcp_tool_info':
        return clone(D.mcp.tools.find((t) => t.server === args.server && t.name === args.tool) || null);
      case 'mcp_has_credentials':
        return args.name === 'centralmcp';
      case 'mcp_export_pins':
        return clone(D.mcp.exportPins);
      case 'greencli_mcp_info':
        return clone(D.mcp.greencli);

      default:
        if (Object.prototype.hasOwnProperty.call(D.answers, cmd)) return clone(D.answers[cmd]);
        if (!cmd.startsWith('plugin:')) console.log('[demo] unhandled command: ' + cmd);
        return null;
    }
  }

  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      calls.push(cmd);
      try {
        return Promise.resolve(handle(cmd, args));
      } catch (e) {
        return Promise.reject(String(e));
      }
    },
    transformCallback: (cb, once) => {
      const id = nextId++;
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        return cb && cb(data);
      });
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback,
    callbacks,
    convertFileSrc: (p) => p,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event, id) => callbacks.delete(id),
  };
  window.__demo = { emit, print, calls };
}
