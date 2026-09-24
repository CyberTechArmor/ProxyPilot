// SQLite CURRENT_TIMESTAMP is UTC but has no suffix. Never interpret it in
// the dashboard host's local timezone. Refuse other ambiguous date formats.
export function utcTimestamp(value) {
  if (typeof value !== 'string') return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value))
    return Date.parse(value.replace(' ', 'T') + 'Z');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return Date.parse(value);
  return NaN;
}
