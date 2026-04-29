export function richText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(richText).filter(Boolean).join("\n");
  if (typeof value !== "object") return String(value);

  for (const key of ["plain_text", "plainText", "markdown", "text", "content"]) {
    if (value[key] !== undefined && value[key] !== null) return richText(value[key]);
  }

  if (value.body !== undefined && value.body !== null) return richText(value.body);
  return "";
}

export function commentBody(comment) {
  if (typeof comment === "string") return comment;
  return richText(comment?.body ?? comment?.content ?? comment?.text ?? comment?.markdown ?? comment?.plain_text ?? comment?.plainText);
}

export function cardDescription(card = {}) {
  return richText(card.description ?? card.body ?? card.content ?? card.text ?? "");
}

export function cardBoardId(card = {}) {
  return card.board_id ?? card.boardId ?? card.board?.id ?? card.board?.board_id ?? card.board?.boardId ?? null;
}

export function cardColumnId(card = {}) {
  return card.column_id ?? card.columnId ?? card.column?.id ?? card.column?.column_id ?? card.column?.columnId ?? null;
}

export function cardStatus(card = {}) {
  return String(card.status ?? card.state ?? card.lifecycle_state ?? card.lifecycleState ?? "").toLowerCase();
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}
