/**
 * ANSI Escape Sequence Processor
 * Handles parsing, stripping, and extracting ANSI color codes from terminal output
 */

export interface AnsiRun {
  text: string;
  ansi: string;
  start: number;
  end: number;
}

export class AnsiProcessor {
  // Match ANSI escape sequences (CSI SGR codes primarily)
  private static readonly ANSI_REGEX =
    /\x1b\[(?:\d{1,4}(?:;\d{1,4})*)?[mGKHfJsuABCD]/g;

  private static readonly COLOR_REGEX =
    /\x1b\[(\d{1,3}(?:;\d{1,3})*)m/;

  /**
   * Strip all ANSI escape sequences from text
   */
  stripAnsi(input: string): string {
    return input.replace(AnsiProcessor.ANSI_REGEX, '');
  }

  /**
   * Check if text contains ANSI sequences
   */
  hasAnsi(input: string): boolean {
    return AnsiProcessor.ANSI_REGEX.test(input);
  }

  /**
   * Extract ANSI-coded runs from text
   */
  extractAnsiRuns(input: string): AnsiRun[] {
    const runs: AnsiRun[] = [];
    let lastIndex = 0;
    let currentAnsi = '';

    // Match color-setting sequences specifically
    const colorRegex = /(\x1b\[(?:\d{1,3}(?:;\d{1,3})*)m)/g;
    let match: RegExpExecArray | null;

    while ((match = colorRegex.exec(input)) !== null) {
      const ansiCode = match[1];
      const ansiStart = match.index;

      // Capture text before this ANSI code
      if (ansiStart > lastIndex) {
        const textBefore = input.slice(lastIndex, ansiStart);
        if (textBefore) {
          runs.push({
            text: textBefore,
            ansi: currentAnsi,
            start: lastIndex,
            end: ansiStart,
          });
        }
      }

      // Check if reset code
      if (ansiCode === '\x1b[0m' || ansiCode === '\x1b[m') {
        currentAnsi = '';
      } else {
        currentAnsi = ansiCode;
      }

      lastIndex = ansiStart + ansiCode.length;
    }

    // Capture remaining text
    if (lastIndex < input.length) {
      runs.push({
        text: input.slice(lastIndex),
        ansi: currentAnsi,
        start: lastIndex,
        end: input.length,
      });
    }

    return runs;
  }

  /**
   * Parse ANSI color to RGB tuple
   * Supports 8-color, 256-color, and 24-bit true color
   */
  ansiToRgb(ansi: string): [number, number, number] | null {
    const match = ansi.match(AnsiProcessor.COLOR_REGEX);
    if (!match) return null;

    const codes = match[1].split(';').map(Number);

    // 24-bit true color: ESC[38;2;R;G;Bm or ESC[48;2;R;G;Bm
    if (
      codes.length === 5 &&
      (codes[0] === 38 || codes[0] === 48) &&
      codes[1] === 2
    ) {
      return [codes[2], codes[3], codes[4]];
    }

    // 256-color: ESC[38;5;Nm or ESC[48;5;Nm
    if (
      codes.length === 3 &&
      (codes[0] === 38 || codes[0] === 48) &&
      codes[1] === 5
    ) {
      return this.color256ToRgb(codes[2]);
    }

    // 8-color basic
    if (codes.length === 1) {
      const code = codes[0];
      if (code >= 30 && code <= 37) {
        return this.basic8Colors[code - 30];
      }
      if (code >= 90 && code <= 97) {
        return this.bright8Colors[code - 90];
      }
      // Default colors
      if (code === 39) return null; // Default foreground
      if (code === 0) return null; // Reset
    }

    return null;
  }

  /**
   * Convert 256-color code to RGB
   */
  color256ToRgb(code: number): [number, number, number] {
    if (code < 0) return [0, 0, 0];
    if (code <= 7) return this.basic8Colors[code];
    if (code <= 15) return this.bright8Colors[code - 8];

    if (code >= 16 && code <= 231) {
      // 6x6x6 color cube
      const c = code - 16;
      const r = Math.floor(c / 36);
      const g = Math.floor((c % 36) / 6);
      const b = c % 6;
      const values = [0, 95, 135, 175, 215, 255];
      return [values[r], values[g], values[b]];
    }

    if (code >= 232 && code <= 255) {
      // Grayscale ramp
      const gray = 8 + (code - 232) * 10;
      return [gray, gray, gray];
    }

    return [255, 255, 255];
  }

  // Basic 8 ANSI colors
  private basic8Colors: [number, number, number][] = [
    [0, 0, 0],       // Black
    [205, 49, 49],   // Red
    [13, 188, 121],  // Green
    [229, 229, 16],  // Yellow
    [36, 114, 200],  // Blue
    [188, 63, 188],  // Magenta
    [17, 168, 205],  // Cyan
    [229, 229, 229], // White
  ];

  // Bright 8 ANSI colors
  private bright8Colors: [number, number, number][] = [
    [85, 85, 85],      // Bright Black
    [255, 85, 85],     // Bright Red
    [85, 255, 85],     // Bright Green
    [255, 255, 85],    // Bright Yellow
    [85, 85, 255],     // Bright Blue
    [255, 85, 255],    // Bright Magenta
    [85, 255, 255],    // Bright Cyan
    [255, 255, 255],   // Bright White
  ];
}

/**
 * Create a fresh AnsiProcessor instance
 */
export function createAnsiProcessor(): AnsiProcessor {
  return new AnsiProcessor();
}
