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
  const legacy = text.match(
    new RegExp(`(?:<!--\\s*fizzy-symphony-(?:marker|workpad)\\s*-->\\s*)?${escapedMarker}\\s*\`\`\`json\\s*([\\s\\S]*?)\\s*\`\`\``, "u")
  );
  if (legacy) return legacy[1];

  const html = text.match(new RegExp(`${escapedMarker}\\s*([\\s\\S]*?)\\s*</code>`, "u"));
  if (html) return decodeHtml(html[1]).trim();

  return null;
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
