'use strict';
// In-memory sliding-window limiter. Strict for login; lenient elsewhere.
const buckets = new Map();

function hit(key, { windowMs, max }) {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= max) {
    const retryAfter = Math.ceil((windowMs - (now - arr[0])) / 1000);
    return { limited: true, retryAfter };
  }
  arr.push(now);
  return { limited: false, remaining: max - arr.length };
}

function reset(key) { buckets.delete(key); }

// periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    while (arr.length && now - arr[0] > 3600_000) arr.shift();
    if (!arr.length) buckets.delete(k);
  }
}, 300_000).unref();

module.exports = { hit, reset };
