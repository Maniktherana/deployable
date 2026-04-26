export function jsonEvent(payload: unknown, options?: { readonly id?: string | number }): string {
  const id = options?.id === undefined ? "" : `id: ${String(options.id)}\n`;
  return `${id}event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}
