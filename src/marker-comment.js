import { canonicalJson } from "./domain.js";

export function markerCommentBody({ sentinel, marker, payload, title, summary = [] }) {
  const markerText = `${marker}\n${canonicalJson(payload)}`;
  const summaryLines = summary.filter(Boolean);

  return [
    sentinel,
    `<p><strong>${escapeHtml(title)}</strong></p>`,
    summaryLines.length > 0 ? `<p>${summaryLines.join("<br>")}</p>` : "",
    `<details><summary>Automation marker</summary><pre><code>${escapeHtml(markerText)}</code></pre></details>`
  ].filter(Boolean).join("\n");
}

export function markerJsonFromBody(body, marker) {
  const text = String(body ?? "");
  const escapedMarker = escapeRegExp(marker);

  for (const block of codeBlocks(text)) {
    const markerJson = jsonAfterMarker(decodeHtml(block), marker);
    if (markerJson) return markerJson;
  }

  const legacy = text.match(
    new RegExp(`(?:<!--\\s*fizzy-symphony-(?:marker|workpad)\\s*-->\\s*)?${escapedMarker}\\s*\`\`\`json\\s*([\\s\\S]*?)\\s*\`\`\``, "u")
  );
  if (legacy) return legacy[1];

  return jsonAfterMarker(decodeHtml(text), marker);
}

export function htmlField(label, value, options = {}) {
  if (value === undefined || value === null || value === "") return "";
  const safeValue = escapeHtml(value);
  const rendered = options.strong
    ? `<strong>${safeValue}</strong>`
    : options.code
      ? `<code>${safeValue}</code>`
      : safeValue;
  return `${escapeHtml(label)}: ${rendered}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function codeBlocks(text) {
  return [...String(text ?? "").matchAll(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/giu)]
    .map((match) => match[1]);
}

function jsonAfterMarker(text, marker) {
  const markerIndex = String(text ?? "").indexOf(marker);
  if (markerIndex === -1) return null;

  const afterMarker = text.slice(markerIndex + marker.length);
  const afterLineBreak = afterMarker.match(/^\s*(?:\r\n|\n|\r)([\s\S]*)$/u);
  if (!afterLineBreak) return null;

  const candidate = afterLineBreak[1].trimStart();
  if (!candidate.startsWith("{")) return null;

  return extractJsonObject(candidate);
}

function extractJsonObject(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }

  return text.trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
