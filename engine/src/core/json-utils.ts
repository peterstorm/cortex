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
 * Strategy: scan each opening `{` or `[` in order until a balanced slice is
 * also valid JSON. The scanner is string/escape-aware, so prose delimiters,
 * braces inside JSON strings, and matching delimiters after the value do not
 * prevent a later valid value from being found.
 *
 * @param text - Raw LLM response text
 * @returns The JSON slice, or null when no JSON-looking value exists
 */
export function extractJsonSlice(text: string): string | null {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;

    const candidate = balancedJsonCandidate(text, start);
    if (candidate === null) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // A prose delimiter (for example "[draft]") is not JSON. Keep
      // scanning rather than allowing it to hide a later structured result.
    }
  }
  return null;
}

function balancedJsonCandidate(text: string, start: number): string | null {
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
