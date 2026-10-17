// Tests for the connection limits (server/src/connLimits.js).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, createConnectionCounter, MAX_CONNECTIONS_PER_IP } from '../src/connLimits.js';

describe('connection limits', () => {
  test('a whole hall on one Wi-Fi (one address) still fits', () => {
    const c = createConnectionCounter();
    for (let i = 0; i < 40; i += 1) assert.equal(c.tryAdd('203.0.113.7'), true);
    assert.ok(MAX_CONNECTIONS_PER_IP >= 40);
  });

  test('one address past the limit is refused; others aren’t affected', () => {
    const c = createConnectionCounter(3);
    assert.equal(c.tryAdd('a'), true);
    assert.equal(c.tryAdd('a'), true);
    assert.equal(c.tryAdd('a'), true);
    assert.equal(c.tryAdd('a'), false);
    assert.equal(c.tryAdd('b'), true);
  });

  test('closing a connection frees its place', () => {
    const c = createConnectionCounter(1);
    c.tryAdd('a');
    assert.equal(c.tryAdd('a'), false);
    c.remove('a');
    assert.equal(c.count('a'), 0);
    assert.equal(c.tryAdd('a'), true);
  });

  test('the real visitor address comes from Cloudflare’s header first', () => {
    const hs = {
      address: '10.0.0.1',
      headers: { 'cf-connecting-ip': '198.51.100.4', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    };
    assert.deepEqual(clientIp(hs), { ip: '198.51.100.4', from: 'cf-connecting-ip' });
  });

  test('then the forwarding header, then the raw address (local development)', () => {
    assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }).ip, '1.2.3.4');
    assert.deepEqual(clientIp({ address: '::1', headers: {} }), { ip: '::1', from: 'socket' });
  });
});
