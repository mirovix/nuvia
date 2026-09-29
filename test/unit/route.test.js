import test from 'node:test';
import assert from 'node:assert/strict';
import { instruction, summarizeRoute, routeUrl, formatDistance } from '../../lib/route.js';

test('istruzioni in italiano', () => {
  assert.equal(instruction({ maneuver: { type: 'turn', modifier: 'left' }, name: 'Via Roma' }), 'Svolta a sinistra in Via Roma');
  assert.equal(instruction({ maneuver: { type: 'turn', modifier: 'slight right' }, name: '' }), 'Svolta leggermente a destra');
  assert.equal(instruction({ maneuver: { type: 'roundabout', exit: 2 }, name: 'SR11' }), 'Alla rotonda prendi la 2ª uscita verso SR11');
  assert.equal(instruction({ maneuver: { type: 'roundabout' }, name: '' }), "Alla rotonda prendi l'uscita");
  assert.equal(instruction({ maneuver: { type: 'depart' }, name: 'Via Tiepolo' }), 'Parti da Via Tiepolo');
  assert.equal(instruction({ maneuver: { type: 'arrive' } }), 'Sei arrivato a destinazione');
});

test('summarizeRoute calcola minuti, km, geometria e passi', () => {
  const summary = summarizeRoute({ routes: [{ duration: 1260, distance: 37840, geometry: { coordinates: [[11.87, 45.40], [11.55, 45.54]] }, legs: [{ steps: [
    { distance: 160, name: 'Via Tiepolo', maneuver: { type: 'depart' } },
    { distance: 900, name: 'Via Roma', maneuver: { type: 'turn', modifier: 'right' } },
    { distance: 0, name: '', maneuver: { type: 'arrive' } }] }] }] });
  assert.equal(summary.minutes, 21);
  assert.equal(summary.kilometers, 37.8);
  assert.deepEqual(summary.geometry[0], [45.40, 11.87]);
  assert.equal(summary.steps.length, 3);
  assert.equal(summary.steps[1].text, 'Svolta a destra in Via Roma');
  assert.equal(summarizeRoute({ routes: [] }), null);
});

test('routeUrl e formatDistance', () => {
  assert.match(routeUrl('https://r', 'bike', { latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }), /routed-bike\/route\/v1\/driving\/2,1;4,3/);
  assert.match(routeUrl('https://r', 'boh', { latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }), /routed-car/);
  assert.equal(formatDistance(240), '240 m');
  assert.equal(formatDistance(1250), '1,3 km');
});
