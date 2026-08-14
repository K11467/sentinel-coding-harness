const REDACTED = '[REDACTED]';
const DEFAULT_MAX_BYTES = 4 * 1024;
const ELLIPSIS = '…';

const sensitiveKey = /(?:^|[-_.])(authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|password|secret|token)(?:$|[-_.])/i;
const headerAssignment = /(\b(?:authorization|cookie|set[-_]?cookie)\b"?\s*(?:[:=])\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,&}]+)/gi;
const valueAssignment = /(\b(?:x[-_]?api[-_]?key|api[-_]?key|password|secret|token)\b"?\s*(?:[:=])\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,&;}\]]+)/gi;
const skToken = /\bsk(?:-|%2d)[a-z0-9._~%/+:-]+\b/gi;
const pemBlock = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g;

function redactAssignmentValue(match: string, prefix: string): string {
  const value = match.slice(prefix.length);
  if (value.startsWith('"')) return `${prefix}"${REDACTED}"`;
  if (value.startsWith("'")) return `${prefix}'${REDACTED}'`;
  return `${prefix}${REDACTED}`;
}

/** Safely shortens text without splitting a UTF-8 character. */
export function truncateUtf8(value: string, maxBytes = DEFAULT_MAX_BYTES): string {
  if (maxBytes < 1 || Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return maxBytes < 1 ? '' : value;
  }

  const suffixBytes = Buffer.byteLength(ELLIPSIS, 'utf8');
  if (maxBytes <= suffixBytes) {
    return '';
  }

  const budget = maxBytes - suffixBytes;
  let used = 0;
  let result = '';
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (used + characterBytes > budget) {
      break;
    }
    result += character;
    used += characterBytes;
  }
  return `${result}${ELLIPSIS}`;
}

/** Redacts secrets in free-form text before it can enter an audit or error message. */
export function redactText(value: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const redacted = value
    .replace(pemBlock, REDACTED)
    .replace(headerAssignment, redactAssignmentValue)
    .replace(valueAssignment, redactAssignmentValue)
    .replace(skToken, REDACTED);

  return truncateUtf8(redacted, maxBytes);
}

/**
 * Returns a deep, non-mutating redacted copy of a JSON-like value.
 * Values associated with sensitive key names are never retained.
 */
export function redact(value: unknown, maxBytes = DEFAULT_MAX_BYTES): unknown {
  if (typeof value === 'string') {
    return redactText(value, maxBytes);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, maxBytes));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        sensitiveKey.test(key) ? REDACTED : redact(nestedValue, maxBytes),
      ]),
    );
  }
  return value;
}

export { DEFAULT_MAX_BYTES, REDACTED };
