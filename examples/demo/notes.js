export function normalizeNote(value) {
  return String(value).trim().slice(0, 200);
}
