import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const vulnerabilities = report.vulnerabilities || {};
const names = Object.keys(vulnerabilities).sort();
const allowed = new Set(['braces', 'chokidar', 'fast-glob', 'micromatch', 'tailwindcss']);
const advisory = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';

if (names.length === 0) process.exit(0);
if (names.some(name => !allowed.has(name))) {
  console.error('Frontend audit contains vulnerabilities outside the temporary Tailwind/braces exception:', names.join(', '));
  process.exit(1);
}

const braces = vulnerabilities.braces;
const directAdvisories = Array.isArray(braces?.via) ? braces.via.filter(v => v && typeof v === 'object') : [];
if (!directAdvisories.some(v => v.url === advisory && v.severity === 'high')) {
  console.error('Expected unpatched braces advisory is absent or changed; refusing the exception.');
  process.exit(1);
}

for (const [name, entry] of Object.entries(vulnerabilities)) {
  const objectVia = Array.isArray(entry?.via) ? entry.via.filter(v => v && typeof v === 'object') : [];
  if (name !== 'braces' && objectVia.length) {
    console.error(`Unexpected direct advisory on ${name}; refusing the exception.`);
    process.exit(1);
  }
}

console.warn('Temporary audit exception: GHSA-vfj7-8cjw-p6xm has no patched braces release and is reachable here only through Tailwind 3 build-time tooling.');
console.warn('Any additional or changed advisory still fails CI. Remove this exception when upstream ships a patched path or Tailwind is deliberately migrated.');
