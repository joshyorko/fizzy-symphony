// Pure terminal formatting helpers for the cockpit text renderer.
//
// Raw ANSI truecolor (same palette family as src/terminal-renderer.js). No
// dependencies. Color is strictly opt-in: when a Painter is disabled every
// helper returns plain text, so non-TTY, NO_COLOR, CI, TERM=dumb, and
// redirected output stay completely ANSI-free and deterministic.

const RESET = "\x1b[0m";
const ANSI_PATTERN = /\x1b\[[0-9;]*m/gu;

const PALETTE = {
  faint: "38;2;100;116;139",
  dim: "38;2;148;163;184",
  blue: "38;2;96;165;250",
  green: "38;2;34;197;94",
  yellow: "38;2;250;204;21",
  red: "38;2;248;113;113",
  magenta: "38;2;244;114;182",
  cyan: "38;2;34;211;238",
  white: "38;2;226;232;240"
} as const;

export type Tone = keyof typeof PALETTE;

export interface Painter {
  readonly enabled: boolean;
  tint(tone: Tone, text: string, bold?: boolean): string;
  bold(text: string): string;
  dim(text: string): string;
  faint(text: string): string;
}

export function createPainter(enabled: boolean): Painter {
  function wrap(code: string, text: string): string {
    if (!enabled) return text;
    return `\x1b[${code}m${text}${RESET}`;
  }
  return {
    enabled,
    tint: (tone, text, bold = false) => wrap(`${bold ? "1;" : ""}${PALETTE[tone]}`, text),
    bold: (text) => wrap("1", text),
    dim: (text) => wrap(PALETTE.dim, text),
    faint: (text) => wrap(PALETTE.faint, text)
  };
}

// Strip ANSI SGR sequences, leaving the visible text. Lets callers reason about
// a line's printable content (e.g. detecting copyable command lines) regardless
// of whether color is enabled.
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// Visible width of a string, ignoring ANSI SGR sequences. Box-drawing and the
// theme glyphs used here are all single-width, so a code-point count is exact.
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

export function padEndVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

// Middle-truncate so both ends (e.g. a long path) stay legible.
export function truncateMiddle(text: string, max: number): string {
  if (max <= 1 || visibleWidth(text) <= max) return text;
  const plain = stripAnsi(text);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${plain.slice(0, head)}…${tail > 0 ? plain.slice(plain.length - tail) : ""}`;
}

// ANSI-aware hard clamp: keep at most `width` visible columns, preserving SGR
// escape sequences (they cost no width) and closing any open color so a
// truncated colored line never leaks formatting. Used to guarantee header and
// section-rail lines never overrun the frame at any terminal width.
export function fitVisible(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  let out = "";
  let count = 0;
  let index = 0;
  let sawAnsi = false;
  while (index < text.length && count < width) {
    if (text[index] === "\x1b") {
      const match = /^\x1b\[[0-9;]*m/u.exec(text.slice(index));
      if (match) {
        out += match[0];
        index += match[0].length;
        sawAnsi = true;
        continue;
      }
    }
    const codePoint = [...text.slice(index)][0];
    out += codePoint;
    index += codePoint.length;
    count += 1;
  }
  if (sawAnsi) out += RESET;
  return out;
}

export function clampWidth(width: number | undefined): number {
  const value = Number.isFinite(width) ? Math.floor(width as number) : 80;
  return Math.max(36, Math.min(value, 160));
}

// A heavy top/bottom frame rule.
export function frameRule(width: number, painter: Painter): string {
  return painter.faint("═".repeat(width));
}

// A light section rule that carries a heading: " Heading ─────────────".
export function headingRule(label: string, width: number, painter: Painter): string {
  const head = ` ${painter.bold(label)} `;
  const used = visibleWidth(head) + 1;
  const dashes = Math.max(0, width - used);
  return `${head}${painter.faint("─".repeat(dashes))}`;
}

// Left/right justified single line within width.
export function justify(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 1) return `${left} ${right}`;
  return `${left}${" ".repeat(gap)}${right}`;
}

export const GLYPH = {
  ok: "✓",
  info: "◆",
  warn: "▲",
  err: "✗",
  setup: "◇",
  offline: "◌",
  dot: "·",
  sel: "▸",
  bar: "▌",
  lane: "▏",
  bullet: "·",
  prompt: "$"
} as const;
