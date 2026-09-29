import test from 'node:test';
import assert from 'node:assert/strict';
import { instruction, summarizeRoute, routeUrl, formatDistance } from '../../lib/route.js';

test('English turn-by-turn instructions', () => {
  assert.equal(instruction({ maneuver: { type: 'turn', modifier: 'left' }, name: 'Via Roma' }), 'Turn left onto Via Roma');
  assert.equal(instruction({ maneuver: { type: 'turn', modifier: 'slight right' }, name: '' }), 'Turn slightly right');
  assert.equal(instruction({ maneuver: { type: 'continue', modifier: 'slight right' }, name: '' }), 'Keep slightly right');
  assert.equal(instruction({ maneuver: { type: 'roundabout', exit: 2 }, name: 'SR11' }), 'At the roundabout, take the 2nd exit onto SR11');
  assert.equal(instruction({ maneuver: { type: 'roundabout', exit: 1 }, name: '' }), 'At the roundabout, take the 1st exit');
  assert.equal(instruction({ maneuver: { type: 'roundabout', exit: 3 }, name: '' }), 'At the roundabout, take the 3rd exit');
  assert.equal(instruction({ maneuver: { type: 'roundabout', exit: 4 }, name: '' }), 'At the roundabout, take the 4th exit');
  assert.equal(instruction({ maneuver: { type: 'roundabout', exit: 11 }, name: '' }), 'At the roundabout, take the 11th exit');
  assert.equal(instruction({ maneuver: { type: 'roundabout' }, name: '' }), 'At the roundabout, take the exit');
  assert.equal(instruction({ maneuver: { type: 'exit roundabout' }, name: 'Via Po' }), 'Exit the roundabout onto Via Po');
  assert.equal(instruction({ maneuver: { type: 'merge', modifier: 'slight left' }, name: 'A4' }), 'Merge onto A4');
  assert.equal(instruction({ maneuver: { type: 'on ramp', modifier: 'slight left' }, name: 'A4' }), 'Take the ramp on the left toward A4');
  assert.equal(instruction({ maneuver: { type: 'off ramp', modifier: 'straight' }, name: 'Padova Est' }), 'Take the exit toward Padova Est');
  assert.equal(instruction({ maneuver: { type: 'fork', modifier: 'left' }, name: 'SS16' }), 'At the fork, keep left onto SS16');
  assert.equal(instruction({ maneuver: { type: 'end of road', modifier: 'right' }, name: 'Via Roma' }), 'At the end of the road, turn right onto Via Roma');
  assert.equal(instruction({ maneuver: { type: 'new name', modifier: 'straight' }, name: 'Via Roma' }), 'Continue onto Via Roma');
  assert.equal(instruction({ maneuver: { type: 'turn', modifier: 'straight' }, name: 'Via Roma' }), 'Continue straight onto Via Roma');
  assert.equal(instruction({ maneuver: { type: 'turn', modifier: 'uturn' }, name: '' }), 'Make a U-turn');
  assert.equal(instruction({ maneuver: { type: 'depart' }, name: 'Via Tiepolo' }), 'Head out on Via Tiepolo');
  assert.equal(instruction({ maneuver: { type: 'arrive' } }), 'You have arrived');
});

test('summarizeRoute computes minutes, km, geometry and steps', () => {
  const summary = summarizeRoute({ routes: [{ duration: 1260, distance: 37840, geometry: { coordinates: [[11.87, 45.40], [11.55, 45.54]] }, legs: [{ steps: [
    { distance: 160, name: 'Via Tiepolo', maneuver: { type: 'depart' } },
    { distance: 900, name: 'Via Roma', maneuver: { type: 'turn', modifier: 'right' } },
    { distance: 0, name: '', maneuver: { type: 'arrive' } }] }] }] });
  assert.equal(summary.minutes, 21);
  assert.equal(summary.kilometers, 37.8);
  assert.deepEqual(summary.geometry[0], [45.40, 11.87]);
  assert.equal(summary.steps.length, 3);
  assert.equal(summary.steps[1].text, 'Turn right onto Via Roma');
  assert.equal(summarizeRoute({ routes: [] }), null);
});

test('routeUrl and formatDistance', () => {
  assert.match(routeUrl('https://r', 'bike', { latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }), /routed-bike\/route\/v1\/driving\/2,1;4,3/);
  assert.match(routeUrl('https://r', 'boh', { latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }), /routed-car/);
  assert.equal(formatDistance(240), '240 m');
  assert.equal(formatDistance(1250), '1.3 km');
});
