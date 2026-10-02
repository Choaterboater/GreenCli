import { describe, expect, it } from 'vitest';
import { CASPER_PROMPT_PREFACE, buildCliPrompt, plainCliError } from './cliPrompt';

const DEVICE = 'Connected to: sw1 (10.0.0.1, aruba-cx)';

describe('buildCliPrompt', () => {
  it('keeps the old Local CLI format without a preface or instructions', () => {
    expect(buildCliPrompt(DEVICE, 'show vlans?')).toBe(`${DEVICE}\nshow vlans?`);
    expect(buildCliPrompt(DEVICE, 'q', { preface: '  ', instructions: '' })).toBe(`${DEVICE}\nq`);
  });

  it('puts the preface first, then a blank line', () => {
    const prompt = buildCliPrompt(DEVICE, 'why is port 1 down?', { preface: CASPER_PROMPT_PREFACE });
    expect(prompt).toBe(`${CASPER_PROMPT_PREFACE}\n\n${DEVICE}\nwhy is port 1 down?`);
  });

  it('puts the agent instructions after the preface', () => {
    const prompt = buildCliPrompt(DEVICE, 'q', { preface: 'P', instructions: ' Read-only: never run config commands. ' });
    expect(prompt).toBe(
      `P\n\nInstructions from your GreenCLI agent:\nRead-only: never run config commands.\n\n${DEVICE}\nq`
    );
  });

  it('hides secrets typed into the question', () => {
    const prompt = buildCliPrompt(DEVICE, 'is this right?\npassword secret123\nusername admin password plaintext secret456');
    expect(prompt).not.toContain('secret456');
    expect(prompt).not.toContain('secret123');
    expect(prompt).toContain('<secret hidden>');
    expect(prompt).toContain('is this right?');
  });
});

describe('plainCliError', () => {
  it('drops the backend label', () => {
    expect(plainCliError('API Error: Stopped.')).toBe('Stopped.');
    expect(plainCliError(new Error('API Error:   Casper failed (exit 9): boom'))).toBe('Casper failed (exit 9): boom');
    expect(plainCliError('IO Error: x')).toBe('IO Error: x');
  });
});
