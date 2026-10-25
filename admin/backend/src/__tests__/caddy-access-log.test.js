import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteAccessLogFilterLines, CADDY_SITE_RENDER_CONTRACT } from '../lib/caddy-site-file.js';

test('service access log filters only the three bearer query keys in URLs and Referer', () => {
  const config = siteAccessLogFilterLines().join('\n');
  assert.equal(config, `        format filter {
            wrap json
            request>uri query {
                delete auth
                delete rauth
                delete login
            }
            request>headers>Referer query {
                delete auth
                delete rauth
                delete login
            }
        }`);
  // This is an encoder filter, never a request URI rewrite or log suppression.
  assert.doesNotMatch(config, /^\s*(?:rewrite|log_skip|uri query)\b/m);
  assert.equal(CADDY_SITE_RENDER_CONTRACT, '7');
});

test('merged domain renderer attaches the encoder to the existing file logger', () => {
  const source = readFileSync(new URL('../routes/services.js', import.meta.url), 'utf8');
  const start = source.indexOf('function buildDomainCaddyConfig(');
  const end = source.indexOf('\n// Read every entry for a domain', start);
  const renderer = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(renderer, /output file \/var\/log\/caddy\/\$\{caddyFileName\(domain\)\}\.log`\);\s*lines\.push\(\.\.\.siteAccessLogFilterLines\(\)\);/);
  assert.equal((renderer.match(/siteAccessLogFilterLines\(\)/g) || []).length, 1);
  assert.equal((renderer.match(/lines\.push\(`    log \{`\)/g) || []).length, 1);
});
