import { setTimeout as sleep } from "node:timers/promises";

export const OPENER_WIDTH = 72;
export const OPENER_LINE_COUNT = 13;

const FULL_COLUMN_WIDTHS = [22, 24, 22];
const COMPACT_COLUMN_WIDTHS = [14, 14, 14];
const COMPACT_WIDTH = 46;
const COMPACT_LINE_COUNT = 7;
const DEFAULT_ANIMATION = "pop";
const DEFAULT_BANNER = "full";
const DEFAULT_FRAME_COUNT = 18;
const DEFAULT_FRAME_DELAY_MS = 20;

const FULL_ART = [
  divider("┌", "┬", "┐", FULL_COLUMN_WIDTHS),
  boardRow([" Backlog        ♫", " Ready for Agents   ★", " Done            ♪"], FULL_COLUMN_WIDTHS),
  boardRow([" column note:  ♩", " golden route cue   ♬", " cadence note: ♫"], FULL_COLUMN_WIDTHS),
  divider("├", "┼", "┤", FULL_COLUMN_WIDTHS),
  boardRow([" ═════♪══════════════", " ═══════♬════════════", " ═════♫══════════════"], FULL_COLUMN_WIDTHS),
  boardRow([" ══♬═══════════════", "  ╔════════════════╗", " ════════♪══════════"], FULL_COLUMN_WIDTHS),
  boardRow([" ═══════♫══════════", "  ║ GOLDEN TICKET  ║ ★", " ═══♩═══════════════"], FULL_COLUMN_WIDTHS),
  boardRow([" ═══════════♪══════", "  ╚════════════════╝", " ═════════♬═════════"], FULL_COLUMN_WIDTHS),
  boardRow([" ♫ card queue", " route: ready -> done", " ♪ completed runs"], FULL_COLUMN_WIDTHS),
  divider("├", "┼", "┤", FULL_COLUMN_WIDTHS),
  boardRow([" FIZZY SYMPHONY", " orchestration score", " board-first agents"], FULL_COLUMN_WIDTHS),
  divider("└", "┴", "┘", FULL_COLUMN_WIDTHS),
  fitLine("      ♪        ♫        ♬        ★        ♩        ♫        ♪", OPENER_WIDTH)
];

const COMPACT_ART = [
  divider("┌", "┬", "┐", COMPACT_COLUMN_WIDTHS),
  boardRow([" ♫ Backlog", " ★ Ready", " ♪ Done"], COMPACT_COLUMN_WIDTHS),
  boardRow([" ═══♪══════", " ╔════════╗", " ═══♬══════"], COMPACT_COLUMN_WIDTHS),
  boardRow([" ═♬════════", " ║ GOLDEN ║", " ═════♫════"], COMPACT_COLUMN_WIDTHS),
  boardRow([" card queue", " ticket ->", " completed"], COMPACT_COLUMN_WIDTHS),
  divider("└", "┴", "┘", COMPACT_COLUMN_WIDTHS),
  fitLine("FIZZY SYMPHONY        ♪   ♫   ♬", COMPACT_WIDTH)
];

const NOTE_CHARS = new Set(["♪", "♫", "♬", "♩", "★"]);
const BOX_CHARS = new Set(["┌", "┬", "┐", "├", "┼", "┤", "└", "┴", "┘", "│", "─"]);
const STAFF_CHARS = new Set(["═", "╔", "╗", "║", "╚", "╝"]);
const ANIMATION_MODES = new Set(["pop", "paint", "none"]);
const BANNER_MODES = new Set(["full", "compact"]);

const ZONE_COLORS = [
  "38;2;96;165;250",
  "38;2;244;114;182",
  "38;2;251;146;60",
  "38;2;163;230;53",
  "38;2;34;211;238"
];
const ZONE_TINTS = [
  "38;2;147;197;253",
  "38;2;249;168;212",
  "38;2;253;186;116",
  "38;2;190;242;100",
  "38;2;103;232;249"
];
const DIM = "38;2;100;116;139";
const WHITE_FLASH = "1;38;2;255;255;255";
const GOLD = "1;38;2;250;204;21";
const GOLD_DIM = "38;2;217;119;6";
const WORDMARK = "1;38;2;255;255;255";

export async function writeOpener(io, options = {}) {
  const stdout = io.stdout;
  const env = options.env ?? io.env ?? process.env;
  const opener = resolveOpenerOptions(env, stdout);
  const frameDelayMs = options.frameDelayMs ?? DEFAULT_FRAME_DELAY_MS;

  if (opener.animate) {
    const frames = renderOpenerFrames({
      animation: opener.animation,
      banner: opener.banner,
      color: opener.color,
      frameCount: options.frameCount ?? DEFAULT_FRAME_COUNT
    });
    const rows = visualLines(frames[0]).lines;

    stdout.write(`\n${terminalFrame(frames[0])}\n`);
    for (let index = 1; index < frames.length; index += 1) {
      if (frameDelayMs > 0) await sleep(frameDelayMs);
      stdout.write(`\x1b[${rows}A${terminalFrame(frames[index])}\n`);
    }
    stdout.write("\n");
    return;
  }

  const rendered = opener.color
    ? renderColorOpener({ banner: opener.banner })
    : renderPlainOpener({ banner: opener.banner });
  stdout.write(`\n${rendered}\n\n`);
}

export function resolveOpenerOptions(env = process.env, stdout = process.stdout) {
  const animation = normalizeEnvOption(env.FIZZY_SYMPHONY_ANIM, ANIMATION_MODES, DEFAULT_ANIMATION);
  const banner = normalizeEnvOption(env.FIZZY_SYMPHONY_BANNER, BANNER_MODES, DEFAULT_BANNER);
  const color = Boolean(stdout?.isTTY) && env.NO_COLOR === undefined && env.TERM !== "dumb";
  return {
    animation,
    banner,
    color,
    animate: shouldAnimateOpener({ animation, env, stdout })
  };
}

export function shouldAnimateOpener({ animation = DEFAULT_ANIMATION, env = process.env, stdout = process.stdout } = {}) {
  if (animation === "none") return false;
  if (!stdout?.isTTY) return false;
  return env.TERM !== "dumb";
}

export function renderPlainOpener(options = {}) {
  return openerLines(options.banner).join("\n");
}

export function renderColorOpener(options = {}) {
  return openerLines(options.banner)
    .map((line, row) => colorizeLine(line, row, { banner: options.banner }))
    .join("\n");
}

export function renderOpenerFrames(options = {}) {
  const banner = normalizeEnvOption(options.banner, BANNER_MODES, DEFAULT_BANNER);
  const animation = normalizeEnvOption(options.animation, ANIMATION_MODES, DEFAULT_ANIMATION);
  const color = options.color !== false;
  const lines = openerLines(banner);
  const count = Math.max(2, options.frameCount ?? DEFAULT_FRAME_COUNT);
  const trace = traceCells(lines, animation);
  const frames = [];

  for (let frame = 0; frame < count - 1; frame += 1) {
    const revealCount = Math.ceil(trace.length * ((frame + 1) / (count - 1)));
    const grid = blankGrid(lines);
    for (const cell of trace.slice(0, revealCount)) {
      grid[cell.row][cell.col] = lines[cell.row][cell.col];
    }
    overlayScrollingNotes(grid, frame, banner);
    const frameLines = grid.map((row) => row.join(""));
    frames.push(renderFrameLines(frameLines, { color, banner, flash: frame >= count - 4 }));
  }

  frames.push(color ? renderColorOpener({ banner }) : renderPlainOpener({ banner }));
  return frames;
}

export function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/gu, "");
}

export function visualLines(text) {
  const lines = stripAnsi(text).split("\n");
  return {
    width: Math.max(...lines.map((line) => Array.from(line).length)),
    lines: lines.length
  };
}

function renderFrameLines(lines, options) {
  if (!options.color) return lines.join("\n");
  return lines.map((line, row) => colorizeLine(line, row, options)).join("\n");
}

function openerLines(banner = DEFAULT_BANNER) {
  const normalized = normalizeEnvOption(banner, BANNER_MODES, DEFAULT_BANNER);
  if (normalized === "compact") return normalizeLines(COMPACT_ART, COMPACT_WIDTH, COMPACT_LINE_COUNT);
  return normalizeLines(FULL_ART, OPENER_WIDTH, OPENER_LINE_COUNT);
}

function normalizeLines(lines, width, count) {
  const normalized = lines.slice(0, count).map((line) => fitLine(line, width));
  while (normalized.length < count) normalized.push(" ".repeat(width));
  return normalized;
}

function divider(left, joiner, right, widths) {
  return `${left}${widths.map((width) => "─".repeat(width)).join(joiner)}${right}`;
}

function boardRow(cells, widths) {
  return `│${cells.map((cell, index) => fitLine(cell, widths[index])).join("│")}│`;
}

function fitLine(line, width) {
  const chars = Array.from(line);
  const fitted = chars.length > width ? chars.slice(0, width) : chars;
  return fitted.join("").padEnd(width, " ");
}

function colorizeLine(line, row, options = {}) {
  const chars = Array.from(line);
  const width = chars.length;
  return chars.map((char, col) => colorizeChar(char, col, row, width, options)).join("");
}

function colorizeChar(char, col, row, width, options) {
  if (char === " ") return char;
  if (isGoldenTicketCell(char, col, row, width, options.banner)) {
    if (options.flash && char !== " ") return style((row + col) % 2 === 0 ? WHITE_FLASH : GOLD, char);
    return style(NOTE_CHARS.has(char) ? WHITE_FLASH : GOLD, char);
  }
  if (NOTE_CHARS.has(char)) return style(ZONE_COLORS[zoneForColumn(col, width)], char);
  if (isWordmarkCell(row, col, width, options.banner)) return style(WORDMARK, char);
  if (STAFF_CHARS.has(char)) return style(GOLD_DIM, char);
  if (BOX_CHARS.has(char)) return style(DIM, char);
  if (char === ">") return style(GOLD, char);
  return style(ZONE_TINTS[zoneForColumn(col, width)], char);
}

function isGoldenTicketCell(char, col, row, width, banner) {
  if (banner === "compact") {
    return row >= 2 && row <= 4 && col >= 16 && col <= 31 && char !== " ";
  }
  const readyStart = Math.floor(width / 3);
  const readyEnd = Math.floor((width / 3) * 2);
  return row >= 5 && row <= 8 && col >= readyStart + 2 && col <= readyEnd - 2 && char !== " ";
}

function isWordmarkCell(row, col, width, banner) {
  if (banner === "compact") return row === 6 && col < 14;
  return row === 10 && col < Math.floor((width / 3) * 2);
}

function traceCells(lines, animation) {
  const cellsByZone = Array.from({ length: 5 }, () => []);
  for (let row = 0; row < lines.length; row += 1) {
    for (let col = 0; col < lines[row].length; col += 1) {
      if (lines[row][col] === " ") continue;
      cellsByZone[zoneForColumn(col, lines[row].length)].push({ row, col });
    }
  }

  if (animation === "pop") {
    for (const cells of cellsByZone) {
      cells.sort((a, b) => b.row - a.row || a.col - b.col);
    }
  } else {
    for (const cells of cellsByZone) {
      cells.sort((a, b) => a.row - b.row || a.col - b.col);
    }
  }

  const ordered = [];
  for (let zone = 0; zone < cellsByZone.length; zone += 1) {
    const offset = zone * 3;
    for (let index = 0; index < cellsByZone[zone].length; index += 1) {
      ordered.push({ ...cellsByZone[zone][index], order: offset + index });
    }
  }
  ordered.sort((a, b) => a.order - b.order || a.row - b.row || a.col - b.col);
  return ordered.map(({ row, col }) => ({ row, col }));
}

function blankGrid(lines) {
  return lines.map((line) => Array.from(line).map(() => " "));
}

function overlayScrollingNotes(grid, frame, banner) {
  const notes = ["♪", "♫", "♬", "♩", "★"];
  const rows = banner === "compact" ? [1, 2, 3] : [1, 4, 5, 6, 7, 12];
  const width = grid[0].length;

  rows.forEach((row, index) => {
    if (!grid[row]) return;
    const col = (frame * 5 + index * 11) % Math.max(1, width - 2);
    if (grid[row][col] === " ") grid[row][col] = notes[(frame + index) % notes.length];
  });
}

function zoneForColumn(col, width) {
  return Math.min(4, Math.floor((col / Math.max(1, width)) * 5));
}

function normalizeEnvOption(value, allowed, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function terminalFrame(frame) {
  return frame.split("\n").map((line) => `\r${line}\x1b[K`).join("\n");
}

function style(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}
