/** Undefined keeps the internal caller's configured tools. An explicit empty list grants none. */
export function selectAllowedTools<T extends { name: string }>(tools: readonly T[], allowed: readonly string[] | undefined): T[] {
  if (allowed === undefined) return [...tools];
  if (!Array.isArray(allowed) || allowed.some(name => typeof name !== 'string')) throw new Error('INVALID_TOOL_ALLOWLIST');
  const names = new Set(allowed);
  return tools.filter(tool => names.has(tool.name));
}
