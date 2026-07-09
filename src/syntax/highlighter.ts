import { Grammar, Token } from '../types';
import { arubaCxGrammar } from './grammar-aruba-cx';
import { arubaApGrammar } from './grammar-aruba-ap';
import { arubaCtrlGrammar } from './grammar-aruba-ctrl';
import { junosGrammar } from './grammar-junos';

// ─── ANSI Color Map (256-color, Solarized-inspired muted palette) ───
const ANSI_COLORS: Record<string, string> = {
  'token-cmd-keyword':    '\x1b[38;5;167m',  // Muted coral — commands (show, config, interface)
  'token-cmd-subcommand': '\x1b[38;5;67m',   // Slate blue  — subcommands (vlan, trunk, access)
  'token-cmd-value':      '\x1b[38;5;72m',   // Soft teal   — IP addresses, numbers, interfaces
  'token-cmd-string':     '\x1b[38;5;136m',  // Golden      — quoted strings
  'token-cmd-comment':    '\x1b[38;5;241m',  // Dark gray   — remarks
  'token-cmd-prompt':     '\x1b[38;5;61m',   // Muted violet — device prompt
  'token-cmd-operator':   '\x1b[38;5;167m',  // Muted coral — | > < operators
  'token-cmd-flag':       '\x1b[38;5;61m',   // Muted violet — --help flags
  'token-default':        '\x1b[0m',          // Reset
};

const ANSI_RESET = '\x1b[0m';
// Soft reset: clears only the foreground colour (SGR 39) so we never wipe a
// device's own bold/underline/reverse attributes when re-emitting tokens.
const ANSI_FG_RESET = '\x1b[39m';

type DetectedDevice = 'aruba-cx' | 'aruba-ap' | 'aruba-controller' | 'juniper-junos' | 'generic';

const NO_MATCH = /a^/;
const genericGrammar: Grammar = {
  name: 'generic',
  commands: [],
  subcommands: [],
  keywords: [],
  operators: [],
  flags: [],
  values: {
    ipAddress: NO_MATCH,
    macAddress: NO_MATCH,
    vlanId: NO_MATCH,
    interfaceName: NO_MATCH,
    number: NO_MATCH,
  },
  promptPattern: NO_MATCH,
};

// ─── Device Detection Patterns ───
interface DevicePattern {
  type: DetectedDevice;
  patterns: RegExp[];
  commandFingerprints: string[];
}

const DEVICE_PATTERNS: DevicePattern[] = [
  {
    type: 'juniper-junos',
    patterns: [
      /^[\w.-]+@[\w.-]+>\s?$/,
      /^[\w.-]+@[\w.-]+#\s?$/,
      /^\{(?:master|backup|primary|secondary|line card)[^}]*\}\s*$/,
      /^\[edit[^\]]*\]\s*$/,
    ],
    commandFingerprints: ['ge-0/', 'xe-0/', 'et-0/', 'set interfaces', 'family inet', 'routing-instances', 'ethernet-switching', '| display set', 'commit confirmed', 'request system'],
  },
  {
    type: 'aruba-cx',
    patterns: [
      /^\(?[A-Za-z0-9][A-Za-z0-9-_]*\(config\)\s*#\s?/,
      /^\(?[A-Za-z0-9][A-Za-z0-9-_]*\(config-\w+\)\s*#\s?/,
      /^\(?(?:vsx-\w+)\)?\s*#\s?/,
    ],
    commandFingerprints: ['vsx-sync', 'vsx-update', 'interface 1/', 'evpn', 'vxlan', 'evi ', 'vni '],
  },
  {
    type: 'aruba-ap',
    patterns: [
      /^\(?(?:iap|Aruba Instant VC)[-#\s]?\)?\s*[\(]?\w*[\)]?[#>]\s?/i,
      /^AP[A-Fa-f0-9]{6}#\s?/,
      /^[A-Za-z][A-Za-z0-9-_]*-VC\s*#\s?/,
    ],
    commandFingerprints: ['iap-master', 'iap-vc', 'virtual-controller', 'cluster', 'swarm', 'dot11g', 'dot11a'],
  },
  {
    type: 'aruba-controller',
    patterns: [
      // Hostname prompt: no internal whitespace, so ordinary parenthesized
      // output like "(some text) #" no longer false-triggers controller detection.
      /^\([A-Za-z][A-Za-z0-9._-]*\)\s*#\s?/,
      /^\(config\)\s*#\s?/,
      /^\(config-\w+\)\s*#\s?/,
      /^\(ArubaMC\)\s*#\s?/,
      /^\( Mobility\w*\)\s*#\s?/,
    ],
    commandFingerprints: ['wlan virtual-ap', 'aaa-profile', 'ap-system-profile', 'airgroup', 'lms-ip', 'blms-ip'],
  },
];

export class ArubaHighlighter {
  private grammar: Grammar;
  private sortedCommands: string[];
  private sortedSubcommands: string[];
  private sortedKeywords: string[];
  private sortedOperators: string[];
  private sortedFlags: string[];
  // Lowercased copies of the sorted lists, precomputed once. matchFromList runs
  // in the highlight hot path, so we avoid re-lowercasing these static grammar
  // tokens on every line/segment (grammar tokens are ASCII, so length is stable).
  private sortedCommandsLower: string[];
  private sortedSubcommandsLower: string[];
  private sortedKeywordsLower: string[];
  private sortedOperatorsLower: string[];
  private sortedFlagsLower: string[];

  constructor(grammar: Grammar) {
    this.grammar = grammar;
    // Sort by length descending for longest-match-first
    this.sortedCommands = [...grammar.commands].sort((a, b) => b.length - a.length);
    this.sortedSubcommands = [...grammar.subcommands].sort((a, b) => b.length - a.length);
    this.sortedKeywords = [...grammar.keywords].sort((a, b) => b.length - a.length);
    this.sortedOperators = [...grammar.operators].sort((a, b) => b.length - a.length);
    this.sortedFlags = [...grammar.flags].sort((a, b) => b.length - a.length);
    // Precompute lowercased forms for case-insensitive matching in matchFromList.
    this.sortedCommandsLower = this.sortedCommands.map((s) => s.toLowerCase());
    this.sortedSubcommandsLower = this.sortedSubcommands.map((s) => s.toLowerCase());
    this.sortedKeywordsLower = this.sortedKeywords.map((s) => s.toLowerCase());
    this.sortedOperatorsLower = this.sortedOperators.map((s) => s.toLowerCase());
    this.sortedFlagsLower = this.sortedFlags.map((s) => s.toLowerCase());
  }

  isGeneric(): boolean {
    return this.grammar.name === 'generic';
  }

  // ─── Token Processing ───

  processLine(line: string, isPrompt: boolean = false): Token[] {
    const tokens: Token[] = [];
    let pos = 0;
    let promptProcessed = false;

    while (pos < line.length) {
      // 1. Handle prompt prefix. The live terminal path can't flag prompt lines
      // in advance (applyToTerminal is called per split line with isPrompt=false),
      // so in addition to the explicit isPrompt hint we opportunistically detect a
      // device prompt at the very start of the line via grammar.promptPattern.
      // The generic grammar uses NO_MATCH, so this never fires for generic output.
      if (!promptProcessed && (isPrompt || pos === 0)) {
        const promptMatch = this.matchPrompt(line, pos);
        if (promptMatch) {
          tokens.push({
            text: promptMatch.text,
            className: 'token-cmd-prompt',
            startPos: pos,
            endPos: pos + promptMatch.text.length,
          });
          pos += promptMatch.text.length;
          promptProcessed = true;
          continue;
        }
      }

      // 2. Skip whitespace
      const wsMatch = line.slice(pos).match(/^\s+/);
      if (wsMatch) {
        tokens.push({
          text: wsMatch[0],
          className: 'token-default',
          startPos: pos,
          endPos: pos + wsMatch[0].length,
        });
        pos += wsMatch[0].length;
        continue;
      }

      // 3. Try value patterns (IPs, MACs, interfaces, VLANs, numbers)
      const valueMatch = this.matchValues(line, pos);
      if (valueMatch) {
        tokens.push(valueMatch);
        pos = valueMatch.endPos;
        continue;
      }

      // 3.5 Pipe filters (Junos '| match', '| display set', '| count', …). Must
      // run BEFORE operators, otherwise the bare '|' is consumed as an operator
      // and the multi-word filter flag never gets a chance to match.
      if (line[pos] === '|') {
        const pipeMatch = this.matchFromList(line, pos, this.sortedFlagsLower, 'token-cmd-flag');
        if (pipeMatch) {
          tokens.push(pipeMatch);
          pos = pipeMatch.endPos;
          continue;
        }
      }

      // 4. Try operators
      const opMatch = this.matchFromList(line, pos, this.sortedOperatorsLower, 'token-cmd-operator');
      if (opMatch) {
        tokens.push(opMatch);
        pos = opMatch.endPos;
        continue;
      }

      // 5. Try flags
      const flagMatch = this.matchFromList(line, pos, this.sortedFlagsLower, 'token-cmd-flag');
      if (flagMatch) {
        tokens.push(flagMatch);
        pos = flagMatch.endPos;
        continue;
      }

      // 6. Try quoted strings
      if (line[pos] === '"' || line[pos] === "'") {
        const strMatch = this.matchString(line, pos);
        if (strMatch) {
          tokens.push(strMatch);
          pos = strMatch.endPos;
          continue;
        }
      }

      // 7. Determine if we're at command position (first word after prompt/whitespace)
      const isCommandPosition = this.isAtCommandPosition(tokens);

      // 8. Try commands (only at command position)
      if (isCommandPosition) {
        const cmdMatch = this.matchFromList(line, pos, this.sortedCommandsLower, 'token-cmd-keyword');
        if (cmdMatch) {
          tokens.push(cmdMatch);
          pos = cmdMatch.endPos;
          continue;
        }
      }

      // 9. Try subcommands
      const subMatch = this.matchFromList(line, pos, this.sortedSubcommandsLower, 'token-cmd-subcommand');
      if (subMatch) {
        tokens.push(subMatch);
        pos = subMatch.endPos;
        continue;
      }

      // 10. Try keywords
      const kwMatch = this.matchFromList(line, pos, this.sortedKeywordsLower, 'token-cmd-keyword');
      if (kwMatch) {
        tokens.push(kwMatch);
        pos = kwMatch.endPos;
        continue;
      }

      // 11. Default - consume one character
      tokens.push({
        text: line[pos],
        className: 'token-default',
        startPos: pos,
        endPos: pos + 1,
      });
      pos++;
    }

    return tokens;
  }

  // ─── ANSI Application ───

  applyToTerminal(line: string, isPrompt: boolean = false): string {
    const tokens = this.processLine(line, isPrompt);
    let result = '';

    for (const token of tokens) {
      // Plain text needs no colour wrapping — emit as-is so we don't disturb
      // any attributes (bold/underline) the device may have set.
      if (token.className === 'token-default') {
        result += token.text;
        continue;
      }
      const ansiCode = ANSI_COLORS[token.className];
      if (!ansiCode) {
        result += token.text;
        continue;
      }
      // Wrap with a foreground-only reset to preserve device text attributes.
      result += `${ansiCode}${token.text}${ANSI_FG_RESET}`;
    }

    return result;
  }

  // ─── Device Type Detection ───

  detectDeviceType(buffer: string): DetectedDevice {
    const lines = buffer.split('\n');
    const scores: Record<string, number> = {
      'aruba-cx': 0,
      'aruba-ap': 0,
      'aruba-controller': 0,
      'juniper-junos': 0,
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      for (const device of DEVICE_PATTERNS) {
        // Check prompt patterns
        for (const pattern of device.patterns) {
          if (pattern.test(trimmed)) {
            scores[device.type] += 2;
          }
        }

        // Check command fingerprints
        for (const fingerprint of device.commandFingerprints) {
          if (trimmed.toLowerCase().includes(fingerprint.toLowerCase())) {
            scores[device.type] += 0.5;
          }
        }
      }
    }

    // Find the highest scoring device type
    let bestType: DetectedDevice = 'generic';
    let bestScore = 0;

    for (const [type, score] of Object.entries(scores)) {
      if (score > bestScore && score >= 1) {
        bestScore = score;
        bestType = type as DetectedDevice;
      }
    }

    return bestType;
  }

  // ─── Factory ───

  static forDeviceType(deviceType: string): ArubaHighlighter {
    return new ArubaHighlighter(ArubaHighlighter.getGrammarForDevice(deviceType));
  }

  static getGrammarForDevice(deviceType: string): Grammar {
    switch (deviceType) {
      case 'aruba-cx':
      case 'aruba-aos-s':
        return arubaCxGrammar;
      case 'aruba-ap':
        return arubaApGrammar;
      case 'aruba-controller':
        return arubaCtrlGrammar;
      case 'juniper-junos':
      case 'mist':
        return junosGrammar;
      default:
        return genericGrammar;
    }
  }

  // ─── Private Helpers ───

  private matchPrompt(line: string, pos: number): { text: string } | null {
    const remaining = line.slice(pos);
    const match = remaining.match(this.grammar.promptPattern);
    if (match) {
      return { text: match[0] };
    }
    return null;
  }

  private matchValues(line: string, pos: number): Token | null {
    // Word boundary before pos (same rule as matchFromList): the fallback path
    // advances one char at a time, so without this a digit run or IP-shaped
    // substring INSIDE an identifier (e.g. 'abc123', 'fw10.0.0.1') gets colored
    // as a value mid-word.
    if (pos > 0 && /[a-zA-Z0-9_.\-]/.test(line[pos - 1])) {
      return null;
    }

    const remaining = line.slice(pos);

    // IP Address
    const ipMatch = remaining.match(this.grammar.values.ipAddress);
    if (ipMatch && ipMatch.index === 0) {
      return {
        text: ipMatch[0],
        className: 'token-cmd-value',
        startPos: pos,
        endPos: pos + ipMatch[0].length,
      };
    }

    // MAC Address
    const macMatch = remaining.match(this.grammar.values.macAddress);
    if (macMatch && macMatch.index === 0) {
      return {
        text: macMatch[0],
        className: 'token-cmd-value',
        startPos: pos,
        endPos: pos + macMatch[0].length,
      };
    }

    // VLAN
    const vlanMatch = remaining.match(this.grammar.values.vlanId);
    if (vlanMatch && vlanMatch.index === 0) {
      return {
        text: vlanMatch[0],
        className: 'token-cmd-value',
        startPos: pos,
        endPos: pos + vlanMatch[0].length,
      };
    }

    // Interface name
    const ifMatch = remaining.match(this.grammar.values.interfaceName);
    if (ifMatch && ifMatch.index === 0) {
      return {
        text: ifMatch[0],
        className: 'token-cmd-value',
        startPos: pos,
        endPos: pos + ifMatch[0].length,
      };
    }

    // Number (but check it's not part of an identifier)
    const numMatch = remaining.match(this.grammar.values.number);
    if (numMatch && numMatch.index === 0) {
      // Only match if standalone (not preceded/followed by letters)
      const nextChar = remaining[numMatch[0].length];
      if (!nextChar || !/[a-zA-Z]/.test(nextChar)) {
        return {
          text: numMatch[0],
          className: 'token-cmd-value',
          startPos: pos,
          endPos: pos + numMatch[0].length,
        };
      }
    }

    return null;
  }

  private matchFromList(
    line: string,
    pos: number,
    sortedListLower: string[],
    className: string
  ): Token | null {
    // Word boundary before pos — don't match in the middle of a word
    if (pos > 0 && /[a-zA-Z0-9_\-]/.test(line[pos - 1])) {
      return null;
    }

    const remaining = line.slice(pos);
    // Lowercase the remaining substring once (not once per list item). The
    // emitted token text is sliced from `remaining` so its original case is
    // preserved, and ASCII grammar tokens keep the same length when lowercased.
    const lowerRemaining = remaining.toLowerCase();
    for (const itemLower of sortedListLower) {
      if (lowerRemaining.startsWith(itemLower)) {
        // Word boundary after match — next char must be whitespace, operator, or EOL
        const after = remaining[itemLower.length];
        if (!after || /[\s|><;!&()\[\]{}]/.test(after)) {
          return {
            text: remaining.slice(0, itemLower.length),
            className,
            startPos: pos,
            endPos: pos + itemLower.length,
          };
        }
      }
    }
    return null;
  }

  private matchString(line: string, pos: number): Token | null {
    const quote = line[pos];
    let end = pos + 1;
    while (end < line.length) {
      if (line[end] === '\\' && end + 1 < line.length) {
        end += 2;
        continue;
      }
      if (line[end] === quote) {
        end++;
        return {
          text: line.slice(pos, end),
          className: 'token-cmd-string',
          startPos: pos,
          endPos: end,
        };
      }
      end++;
    }
    return null;
  }

  private isAtCommandPosition(tokens: Token[]): boolean {
    // Command position = start of line or after prompt + whitespace
    if (tokens.length === 0) return true;
    const lastToken = tokens[tokens.length - 1];
    if (lastToken.className === 'token-cmd-prompt') return true;
    if (lastToken.className === 'token-default' && /^\s+$/.test(lastToken.text)) {
      // Check if previous non-whitespace token is operator
      for (let i = tokens.length - 2; i >= 0; i--) {
        const t = tokens[i];
        if (t.className === 'token-default' && /^\s+$/.test(t.text)) continue;
        if (t.className === 'token-cmd-operator') return true;
        return false;
      }
      return true; // Only whitespace/prompt before
    }
    return false;
  }

  // ─── Getters ───

  getGrammar(): Grammar {
    return this.grammar;
  }
}

// ─── Convenience Exports ───

export { arubaCxGrammar, arubaApGrammar, arubaCtrlGrammar, junosGrammar };
export * from './ansi-processor';
