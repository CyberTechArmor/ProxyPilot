import test from 'node:test';
import assert from 'node:assert/strict';
import proxyAddr from 'proxy-addr';

test('IPv4-mapped IPv6 trust prefixes cannot turn an outside client into a trusted proxy',()=>{
  const outside='198.51.100.7';
  for(const subnet of ['::ffff:10.0.0.0/8','::/1']) {
    const trust=proxyAddr.compile([subnet]);
    assert.equal(trust(outside),false,subnet);
    assert.equal(proxyAddr({socket:{remoteAddress:outside},headers:{'x-forwarded-for':'10.1.2.3'}},trust),outside);
  }
  const intended=proxyAddr.compile(['::ffff:10.0.0.0/104']);
  assert.equal(intended('10.1.2.3'),true);
  assert.equal(intended(outside),false);
});
