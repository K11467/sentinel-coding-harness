const REDACTED = '[REDACTED]';
const DEFAULT_MAX_BYTES = 4 * 1024;
const ELLIPSIS = '…';
const MAX_REDACTION_DEPTH = 12;
const MAX_REDACTION_ITEMS = 256;

const sensitiveField =
  '(?:authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|client[-_]?secret|access[-_]?token|secret[-_]?key|private[-_]?key|password|secret|token)';
const sensitiveKey = new RegExp(`(?:^|[-_.])${sensitiveField}(?:$|[-_.])`, 'i');
const headerAssignment = /(\b(?:authorization|cookie|set[-_]?cookie)\b"?\s*(?:[:=])\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,&}]+)/gi;
const valueAssignment = new RegExp(
  `(\\b${sensitiveField}\\b"?\\s*(?:[:=])\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,&;}\\]]+)`,
  'gi',
);
const skToken = /\bsk(?:-|%2d)[a-z0-9._~%/+:-]+\b/gi;
const pemBlock = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/g;
const dangerousKey = new Set(['__proto__', 'constructor', 'prototype']);

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

function redactArray(value: unknown[], maxBytes: number, seen: WeakSet<object>, depth: number): unknown[] {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || typeof lengthDescriptor.value !== 'number') {
    return [REDACTED];
  }

  const result: unknown[] = [];
  const limit = Math.min(lengthDescriptor.value, MAX_REDACTION_ITEMS);
  for (let index = 0; index < limit; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      result.push(undefined);
    } else if (!('value' in descriptor)) {
      result.push(REDACTED);
    } else {
      result.push(redactValue(descriptor.value, maxBytes, seen, depth + 1));
    }
  }
  if (lengthDescriptor.value > limit) {
    result.push(REDACTED);
  }
  return result;
}

function redactObject(value: object, maxBytes: number, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = Object.getOwnPropertyNames(value);
  let itemCount = 0;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable) {
      continue;
    }
    if (itemCount >= MAX_REDACTION_ITEMS) {
      Object.defineProperty(result, '[TRUNCATED]', { value: REDACTED, enumerable: true });
      break;
    }
    itemCount += 1;

    const redactedValue =
      dangerousKey.has(key) || sensitiveKey.test(key) || !('value' in descriptor)
        ? REDACTED
        : redactValue(descriptor.value, maxBytes, seen, depth + 1);
    Object.defineProperty(result, key, { value: redactedValue, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function redactValue(value: unknown, maxBytes: number, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') {
    return redactText(value, maxBytes);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_REDACTION_DEPTH || seen.has(value)) {
      return REDACTED;
    }
    seen.add(value);
    try {
      return redactArray(value, maxBytes, seen, depth);
    } catch {
      return REDACTED;
    }
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_REDACTION_DEPTH || seen.has(value)) {
      return REDACTED;
    }
    seen.add(value);
    try {
      return redactObject(value, maxBytes, seen, depth);
    } catch {
      return REDACTED;
    }
  }
  return value;
}

/**
 * Returns a deep, non-mutating redacted copy of a JSON-like value.
 * Values associated with sensitive key names are never retained.
 */
export function redact(value: unknown, maxBytes = DEFAULT_MAX_BYTES): unknown {
  try {
    return redactValue(value, maxBytes, new WeakSet<object>(), 0);
  } catch {
    return REDACTED;
  }
}

export { DEFAULT_MAX_BYTES, MAX_REDACTION_DEPTH, REDACTED };
