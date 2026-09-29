// Address lookup on top of Nominatim. A single free-text query often lands in the
// wrong town ("Via Tiepolo, Padova" -> Camposampiero, province of Padova), so we
// run a few query variants and rank the candidates against the parsed address.

const STREET_PREFIX = /^(via|viale|v\.?le|piazza|p\.?za|piazzale|p\.?le|corso|c\.?so|largo|vicolo|strada|str\.|contra'?|contrà|borgo|lungadige|riviera|calle|salita|stradella|località|localita|loc\.|street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.|lane|drive|rue|calle|strasse|straße)\s+/i;
// English addresses usually put the street type last ("Baker Street").
const STREET_SUFFIX = /\s+(?:street|st|road|rd|avenue|ave|lane|drive|boulevard|way|place)\.?$/i;

export function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function parseAddress(text, cityHint = '') {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const postcode = raw.match(/\b\d{5}\b/)?.[0] || '';
  const cleaned = raw.replace(/\b\d{5}\b/, ' ').replace(/\bitalia\b/i, ' ').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/^,|,$/g, '').trim();
  const parts = cleaned.split(',').map(part => part.trim()).filter(Boolean);
  let street = parts[0] || '';
  let city = String(cityHint || '').trim() || parts.slice(1).join(' ');
  let number = '';
  const withNumber = street.match(/^(.*?\D)\s+(\d+[a-z]?(?:\/[a-z0-9]+)?)(?:\s+(.+))?$/i);
  if (withNumber) {
    street = withNumber[1].trim();
    number = withNumber[2];
    if (!city && withNumber[3]) city = withNumber[3].trim();
  } else if (parts[1] && /^\d+[a-z]?$/i.test(parts[1])) {
    number = parts[1];
    city = String(cityHint || '').trim() || parts.slice(2).join(' ');
  }
  let cityGuess = '';
  let streetGuess = street;
  if (!city) {
    const words = street.split(' ');
    if (words.length >= 3 || (words.length === 2 && !STREET_PREFIX.test(street))) {
      cityGuess = words.at(-1);
      streetGuess = words.slice(0, -1).join(' ');
    }
  }
  return { raw, street, number, postcode, city, cityGuess, streetGuess };
}

export function queryVariants(parsed) {
  const city = parsed.city || parsed.cityGuess;
  const street = parsed.city ? parsed.street : (parsed.cityGuess ? parsed.streetGuess : parsed.street);
  const bare = street.replace(STREET_PREFIX, '');
  const variants = [];
  const includesCity = parsed.city && normalize(parsed.raw).includes(normalize(parsed.city));
  variants.push({ q: [parsed.raw, parsed.city && !includesCity ? parsed.city : ''].filter(Boolean).join(', ') });
  if (city && street) variants.push({ street: [parsed.number, street].filter(Boolean).join(' '), city, ...(parsed.postcode ? { postalcode: parsed.postcode } : {}) });
  if (city && bare && bare !== street) variants.push({ q: [bare, parsed.number, city].filter(Boolean).join(' ') });
  const seen = new Set();
  return variants.filter(variant => { const key = JSON.stringify(variant); if (seen.has(key)) return false; seen.add(key); return true; });
}

function townOf(address = {}) {
  return address.city || address.town || address.village || address.municipality || address.hamlet || '';
}

export function scorePlace(place, parsed) {
  const address = place.address || {};
  const town = normalize(townOf(address));
  const city = normalize(parsed.city || parsed.cityGuess || '');
  let score = Number(place.importance || 0) * 2;
  if (city) {
    if (town === city) score += 10;
    else if (town && (town.includes(city) || city.includes(town))) score += 6;
    else if (normalize(address.county) === city) score -= 1;
    else score -= 4;
  }
  if (parsed.postcode && address.postcode === parsed.postcode) score += 4;
  if (parsed.number) score += normalize(address.house_number) === normalize(parsed.number) ? 5 : -1;
  const road = normalize(address.road || address.pedestrian || address.square || address.footway || place.name || '');
  const street = parsed.city ? parsed.street : (parsed.streetGuess || parsed.street);
  const tokens = normalize(street.replace(STREET_PREFIX, '').replace(STREET_SUFFIX, '')).split(' ').filter(token => token.length > 2);
  if (tokens.length) {
    const hits = tokens.filter(token => road.includes(token)).length;
    score += hits === tokens.length ? 4 : hits ? 1 : -3;
  }
  return score;
}

export function shortLabel(place) {
  const address = place.address || {};
  const road = address.road || address.pedestrian || address.square || place.name || '';
  const first = [road, address.house_number].filter(Boolean).join(' ');
  const town = townOf(address);
  return [first, town].filter(Boolean).join(', ') || place.display_name;
}

export function rankPlaces(places, parsed) {
  const unique = new Map();
  for (const place of places) {
    const key = `${place.osm_type}:${place.osm_id}` || place.place_id;
    if (!unique.has(key)) unique.set(key, place);
  }
  return [...unique.values()]
    .map(place => ({ place, score: scorePlace(place, parsed) }))
    .sort((a, b) => b.score - a.score)
    .map(({ place, score }) => ({ latitude: Number(place.lat), longitude: Number(place.lon), label: shortLabel(place), full: place.display_name, score }));
}

let lastRequest = 0;
const cache = new Map();

// Nominatim's policy is one request per second; keep to it even when variants pile up.
async function throttled(task) {
  const wait = Math.max(0, lastRequest + 1050 - Date.now());
  lastRequest = Date.now() + wait;
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  return task();
}

export async function geocode(text, { cityHint = '', baseUrl = 'https://nominatim.openstreetmap.org', fetchImpl = fetch, userAgent = 'Nuvia/0.6 (desktop dashboard)', limit = 5 } = {}) {
  const parsed = parseAddress(text, cityHint);
  if (!parsed.raw) return [];
  const cacheKey = `${baseUrl}|${parsed.raw}|${cityHint}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const found = [];
  const variants = queryVariants(parsed);
  for (const [index, variant] of variants.entries()) {
    // Native place names (Padova, München) match how people type local addresses.
    const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '8', 'accept-language': 'native', ...variant });
    try {
      const response = await throttled(() => fetchImpl(`${baseUrl}/search?${params}`, { headers: { 'user-agent': userAgent } }));
      if (response.ok) found.push(...await response.json());
    } catch {}
    const ranked = rankPlaces(found, parsed);
    // Stop early once a candidate matches town and street convincingly.
    if (ranked[0]?.score >= 14 && index < variants.length - 1) break;
  }
  const result = rankPlaces(found, parsed).slice(0, limit);
  if (result.length) cache.set(cacheKey, result);
  return result;
}
