import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, queryVariants, rankPlaces, geocode } from '../../lib/geocode.js';

const place = (road, number, town, extra = {}) => ({ osm_type: 'way', osm_id: `${road}${number}${town}`, lat: '45.4', lon: '11.8', importance: 0.2, display_name: `${number}, ${road}, ${town}, Italia`, address: { road, house_number: number, city: town, postcode: extra.postcode }, ...extra });

test('parseAddress separa via, civico, CAP e città', () => {
  assert.deepEqual(
    (({ street, number, postcode, city }) => ({ street, number, postcode, city }))(parseAddress('Corso Palladio 98 vicenza 36100')),
    { street: 'Corso Palladio', number: '98', postcode: '36100', city: 'vicenza' });
  assert.equal(parseAddress('Piazza Garibaldi, Padova').city, 'Padova');
  assert.equal(parseAddress('Via Roma 5', 'Vicenza').city, 'Vicenza');
  const guess = parseAddress('Via tiepolo padova');
  assert.equal(guess.city, '');
  assert.equal(guess.cityGuess, 'padova');
  assert.equal(guess.streetGuess, 'Via tiepolo');
});

test('queryVariants aggiunge la ricerca strutturata e quella senza "Via"', () => {
  const variants = queryVariants(parseAddress('Via tiepolo padova'));
  assert.ok(variants.some(v => v.street === 'Via tiepolo' && v.city === 'padova'));
  assert.ok(variants.some(v => v.q === 'tiepolo padova'));
});

test('rankPlaces preferisce la città scritta (Tiepolo, Padova e non Camposampiero)', () => {
  const parsed = parseAddress('Via tiepolo padova');
  const ranked = rankPlaces([
    place('Via Tiepolo', '', 'Camposampiero', { importance: 0.3 }),
    place('Via Tiepolo', '', 'Montegrotto Terme'),
    place('Via Giovanni Battista Tiepolo', '', 'Padova', { importance: 0.1 })
  ], parsed);
  assert.equal(ranked[0].label, 'Via Giovanni Battista Tiepolo, Padova');
});

test('rankPlaces premia civico e CAP', () => {
  const parsed = parseAddress('Corso Palladio 98', 'Vicenza');
  const ranked = rankPlaces([place('Corso Palladio', '12', 'Vicenza'), place('Corso Andrea Palladio', '98', 'Vicenza', { postcode: '36100' }), place('Corso Palladio', '98', 'Verona')], parsed);
  assert.equal(ranked[0].label, 'Corso Andrea Palladio 98, Vicenza');
});

test('geocode interroga le varianti e ordina i risultati', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const params = new URL(url).searchParams;
    const body = params.get('q') === 'tiepolo padova' ? [place('Via Giovanni Battista Tiepolo', '', 'Padova')] : [place('Via Tiepolo', '', 'Camposampiero', { importance: 0.4 })];
    return { ok: true, json: async () => body };
  };
  const result = await geocode('Via tiepolo padova', { fetchImpl, baseUrl: 'http://mock' });
  assert.equal(result[0].label, 'Via Giovanni Battista Tiepolo, Padova');
  assert.ok(calls.length >= 2);
});
