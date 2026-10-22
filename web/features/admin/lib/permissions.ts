export function parsePermissions(raw: unknown): unknown[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function hasPermission(permissions: unknown, required: unknown): boolean {
  const list = parsePermissions(permissions);
  return list.includes(required);
}
