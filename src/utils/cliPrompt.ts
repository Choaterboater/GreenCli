// The prompt GreenCLI sends to a CLI provider (Local CLI or Casper).
//
// A CLI answers from this text alone: it gets no GreenCLI tools and no
// terminal output, so the prompt stays small. Both kinds of CLI keep their
// conversations on disk, so the typed question goes through the same secret
// hider as everything else the AI sees.

import { scrubText } from './secrets/scrub';

/** Casper is an agent that can run commands on this computer: tell it what
 *  this question is, and what not to try. */
export const CASPER_PROMPT_PREFACE =
  "You are answering a network engineer in GreenCLI's AI panel. Don't try to connect to their devices or to local ports on this computer. If a command on the device would help, say which one to run and why.";

export interface CliPromptOptions {
  /** Comes first, then a blank line. */
  preface?: string;
  /** The attached GreenCLI agent's instructions. */
  instructions?: string;
}

/**
 * `[preface]` `[agent instructions]` `<device line>` `<question>`, with
 * secrets in the question hidden. Without a preface or instructions this is
 * the old Local CLI prompt: `"<device line>\n<question>"`.
 */
export function buildCliPrompt(deviceLine: string, question: string, opts: CliPromptOptions = {}): string {
  let out = '';
  const preface = opts.preface?.trim();
  if (preface) out += `${preface}\n\n`;
  const instructions = opts.instructions?.trim();
  if (instructions) out += `Instructions from your GreenCLI agent:\n${scrubText(instructions).text}\n\n`;
  return `${out}${deviceLine}\n${scrubText(question).text}`;
}

/** A rejected `ai_cli` call as plain words: drops the backend's "API Error: " label. */
export function plainCliError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^API Error:\s*/, '');
}
