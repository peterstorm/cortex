/**
 * JSON extraction helpers for LLM response parsing.
 *
 * Models frequently wrap or follow structured JSON with prose (explanations,
 * markdown fences, acknowledgements). These helpers carve the JSON value out
 * of surrounding text so parsing is robust to trailing explanations.
 */

/**
 * Extract the first JSON value (object or array) from a text blob.
 *
 * Strategy: find the earliest opening `{` or `[`, then slice through the
 * last matching closer. This tolerates leading and trailing prose, but
 * deliberately does not perform brace matching — for LLM-shaped output
 * (one JSON value plus prose) the first-open/last-close heuristic is
 * correct and cheap.
 *
 * @param text - Raw LLM response text
 * @returns The JSON slice, or null when no JSON-looking value exists
 */
export function extractJsonSlice(text: string): string | null {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  if (firstBrace === -1 && firstBracket === -1) return null;

  let start: number;
  let closer: '}' | ']';
  if (firstBracket === -1 || (firstBrace !== -1 && firstBrace < firstBracket)) {
    start = firstBrace;
    closer = '}';
  } else {
    start = firstBracket;
    closer = ']';
  }

  const end = text.lastIndexOf(closer);
  if (end <= start) return null;

  return text.slice(start, end + 1);
}

/**
 * Try parsing strict JSON from text using every available extraction
 * strategy: code fence content, then the first JSON-looking slice, then
 * the raw text. Returns the parsed value or null.
 */
export function parseJsonFromLlmText<T>(text: string): T | null {
  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  const candidates = [fenceMatch?.[1], extractJsonSlice(text), text].filter(
    (c): c is string => typeof c === 'string' && c.trim().length > 0
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim()) as T;
    } catch {
      // Try the next extraction strategy
    }
  }
  return null;
}
