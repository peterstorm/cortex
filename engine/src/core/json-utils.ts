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
 * Strategy: find the earliest opening `{` or `[`, then scan until that JSON
 * value's delimiters balance. The scanner is string/escape-aware, so braces
 * inside JSON strings and matching delimiters in trailing prose are ignored.
 *
 * @param text - Raw LLM response text
 * @returns The JSON slice, or null when no JSON-looking value exists
 */
export function extractJsonSlice(text: string): string | null {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  if (firstBrace === -1 && firstBracket === -1) return null;

  const start = firstBracket === -1 || (firstBrace !== -1 && firstBrace < firstBracket)
    ? firstBrace
    : firstBracket;
  const expectedClosers: Array<'}' | ']'> = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      expectedClosers.push('}');
    } else if (character === '[') {
      expectedClosers.push(']');
    } else if (character === '}' || character === ']') {
      if (expectedClosers.pop() !== character) return null;
      if (expectedClosers.length === 0) return text.slice(start, index + 1);
    }
  }

  return null;
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
