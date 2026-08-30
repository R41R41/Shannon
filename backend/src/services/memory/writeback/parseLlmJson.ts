/** Best-effort JSON.parse for LLM output that may contain LaTeX backslashes. */
export function parseLlmJsonObject(text: string): unknown {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  const raw = jsonMatch[0];
  try {
    return JSON.parse(raw);
  } catch {
    const repaired = raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}
