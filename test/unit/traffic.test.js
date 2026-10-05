import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficSource, describeTraffic, formatMinutes, parseTraffic, trafficLevel, trafficUrl } from '../../lib/traffic.js';

const A = { latitude: 45.4064, longitude: 11.8768 };
const B = { latitude: 45.5455, longitude: 11.5353 };
const answer = (travel, free, delay, meters = 67800) => ({ routes: [{ summary: { travelTimeInSeconds: travel, noTrafficTravelTimeInSeconds: free, trafficDelayInSeconds: delay, lengthInMeters: meters } }] });
const reply = (status, body) => ({ ok: status === 200, status, json: async () => body });

test('the request asks for live traffic and both travel times', () => {
  const url = new URL(trafficUrl('KEY-123', A, B));
  assert.equal(url.host, 'api.tomtom.com');
  assert.ok(url.pathname.endsWith('/45.406400,11.876800:45.545500,11.535300/json'));
  assert.equal(url.searchParams.get('traffic'), 'true');
  assert.equal(url.searchParams.get('computeTravelTimeFor'), 'all');
  assert.equal(url.searchParams.get('key'), 'KEY-123');
  assert.equal(trafficUrl('', A, B), null);
});

test('the answer becomes live minutes, free-flow minutes and the delay', () => {
  assert.deepEqual(parseTraffic(answer(2820, 2400, 420)), { liveMinutes: 47, freeMinutes: 40, delayMinutes: 7, kilometers: 67.8 });
  // Older answers without the extra fields still give a usable live time.
  assert.deepEqual(parseTraffic({ routes: [{ summary: { travelTimeInSeconds: 600 } }] }), { liveMinutes: 10, freeMinutes: 10, delayMinutes: 0, kilometers: null });
  assert.equal(parseTraffic({ routes: [] }), null);
  assert.equal(parseTraffic(null), null);
});

test('the delay is described the way a driver reads it', () => {
  assert.equal(describeTraffic({ delayMinutes: 7, freeMinutes: 40 }), '+7 min traffic');
  assert.equal(describeTraffic({ delayMinutes: 0, freeMinutes: 40 }), 'clear roads');
  assert.equal(describeTraffic({ delayMinutes: 75, freeMinutes: 200 }), '+1 h 15 min traffic');
  assert.equal(describeTraffic(null), '');
  assert.equal(formatMinutes(120), '2 h');
});

test('the delay is graded against the length of the trip', () => {
  assert.equal(trafficLevel({ delayMinutes: 1, freeMinutes: 40 }), 'clear');
  assert.equal(trafficLevel({ delayMinutes: 7, freeMinutes: 40 }), 'slow');
  assert.equal(trafficLevel({ delayMinutes: 6, freeMinutes: 10 }), 'heavy');
  assert.equal(trafficLevel({ delayMinutes: 20, freeMinutes: 120 }), 'heavy');
});

test('only driving asks for traffic, and repeated refreshes are cached', async () => {
  let calls = 0;
  let clock = 0;
  const traffic = createTrafficSource({ fetchImpl: async () => { calls += 1; return reply(200, answer(2820, 2400, 420)); }, now: () => clock });
  assert.equal((await traffic('KEY', A, B, 'car')).delayMinutes, 7);
  assert.equal((await traffic('KEY', A, B, 'car')).delayMinutes, 7);
  assert.equal(calls, 1, 'the second refresh is served from the cache');
  clock += 4 * 60 * 1000;
  await traffic('KEY', A, B, 'car');
  assert.equal(calls, 2, 'the cache expires');
  assert.equal(await traffic('KEY', A, B, 'bike'), null);
  assert.equal(await traffic('', A, B, 'car'), null);
  assert.equal(calls, 2, 'no key and no car means no request');
});

test('a refused key or an outage never breaks the route', async () => {
  const errors = [];
  let mode = 'ok';
  let clock = 0;
  const traffic = createTrafficSource({
    now: () => clock,
    onError: error => errors.push(error.message),
    fetchImpl: async () => {
      if (mode === 'ok') return reply(200, answer(1800, 1500, 300));
      if (mode === 'denied') return reply(403, {});
      throw new Error('offline');
    }
  });
  assert.equal((await traffic('KEY', A, B, 'car')).delayMinutes, 5);
  clock += 10 * 60 * 1000;
  mode = 'down';
  assert.equal((await traffic('KEY', A, B, 'car')).delayMinutes, 5, 'the last known delay is kept');
  clock += 10 * 60 * 1000;
  mode = 'denied';
  await traffic('KEY', A, B, 'car');
  assert.deepEqual(errors, ['offline', 'the traffic key was refused']);
});
