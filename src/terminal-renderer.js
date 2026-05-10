const RESET = "\x1b[0m";

const COLORS = {
  dim: "38;2;100;116;139",
  primary: "1;38;2;96;165;250",
  success: "1;38;2;34;197;94",
  warning: "1;38;2;250;204;21",
  error: "1;38;2;248;113;113",
  accent: "1;38;2;244;114;182"
};

const MARKERS = {
  primary: "◆",
  success: "✓",
  warning: "▲",
  error: "✗",
  accent: "◇",
  dim: "·"
};

export function createTerminalRenderer(options = {}) {
  const color = options.color === true;

  function paint(kind, text) {
    if (!color) return String(text);
    return `\x1b[${COLORS[kind] ?? COLORS.primary}m${text}${RESET}`;
  }

  function marker(kind = "accent") {
    return paint(kind, MARKERS[kind] ?? MARKERS.accent);
  }

  function badge(kind, text) {
    return paint(kind, `[${String(text).trim().toUpperCase()}]`);
  }

  function muted(text) {
    return paint("dim", text);
  }

  function title(text, subtitle = "") {
    const lines = [`${marker("primary")} ${paint("primary", text)}`];
    if (subtitle) lines.push(`  ${muted(subtitle)}`);
    return lines.join("\n");
  }

  function section(text) {
    return paint("primary", text);
  }

  function label(text, width = 14) {
    return paint("primary", `${String(text).padEnd(width, " ")} `);
  }

  function kvRows(rows = [], rowOptions = {}) {
    const entries = rows
      .filter(Boolean)
      .map(([key, value]) => [String(key), value === undefined || value === null || value === "" ? "unknown" : String(value)]);
    const width = rowOptions.width ?? Math.max(14, ...entries.map(([key]) => key.length));
    return entries
      .map(([key, value]) => `  ${label(key, width)} ${value}`)
      .join("\n");
  }

  function table(headers = [], rows = []) {
    const body = rows.map((row) => row.map((cell) => cell === undefined || cell === null || cell === "" ? "-" : String(cell)));
    const header = headers.map(String);
    const widths = header.map((heading, index) => Math.max(
      heading.length,
      ...body.map((row) => row[index]?.length ?? 0)
    ));
    const format = (row) => `  ${row.map((cell, index) => String(cell).padEnd(widths[index], " ")).join("  ").trimEnd()}`;
    return [format(header), ...body.map(format)].join("\n");
  }

  function callout(kind, heading, lines = []) {
    const body = Array.isArray(lines) ? lines : [lines];
    return [
      `${marker(kind)} ${paint(kind, heading)}`,
      ...body.filter(Boolean).map((line) => `  ${line}`)
    ].join("\n");
  }

  return {
    badge,
    callout,
    kvRows,
    label,
    marker,
    muted,
    section,
    table,
    title
  };
}

export function supportsColor(env = process.env, stream = process.stdout) {
  return Boolean(stream?.isTTY) &&
    env.NO_COLOR === undefined &&
    env.CI === undefined &&
    env.TERM !== "dumb";
}
