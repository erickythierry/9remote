// Mirrors JS `e.message` on an unknown catch value: undefined when absent, never String(e).
export function errorMessage(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("message" in e)) return undefined;
  const { message } = e;
  return typeof message === "string" ? message : undefined;
}
