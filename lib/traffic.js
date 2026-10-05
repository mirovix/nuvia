// Live traffic for the commute widget.
//
// The router that draws the route (OSRM) only knows free-flow speeds, so the
// live delay comes from TomTom's routing API: a free key (2,500 requests a day,
// no card) pasted in Settings → Integrations. Without a key Nuvia simply says
// nothing about traffic instead of guessing.
//
// Only driving has live traffic: cycling and walking are unaffected by jams.

export const TRAFFIC_MODES = new Set(['car']);
export const TOMTOM_KEYS_URL = 'https://developer.tomtom.com/user/register';

export function trafficUrl(key, start, end, { baseUrl = 'https://api.tomtom.com' } = {}) {
  if (!key || !start || !end) return null;
  const point = place => `${Number(place.latitude).toFixed(6)},${Number(place.longitude).toFixed(6)}`;
  const query = new URLSearchParams({ key, traffic: 'true', travelMode: 'car', routeType: 'fastest', computeTravelTimeFor: 'all', instructionsType: 'none', sectionType: 'traffic' });
  return `${baseUrl}/routing/1/calculateRoute/${point(start)}:${point(end)}/json?${query}`;
}

/** TomTom's answer → live minutes, free-flow minutes and the delay between them. */
export function parseTraffic(json) {
  const summary = json?.routes?.[0]?.summary;
  const live = Number(summary?.travelTimeInSeconds);
  if (!Number.isFinite(live) || live <= 0) return null;
  const free = Number.isFinite(Number(summary.noTrafficTravelTimeInSeconds)) ? Number(summary.noTrafficTravelTimeInSeconds) : live;
  // TomTom already routes around jams, so its own delay can be smaller than live − free.
  const delay = Number.isFinite(Number(summary.trafficDelayInSeconds)) ? Number(summary.trafficDelayInSeconds) : Math.max(0, live - free);
  return {
    liveMinutes: Math.max(1, Math.round(live / 60)),
    freeMinutes: Math.max(1, Math.round(free / 60)),
    delayMinutes: Math.max(0, Math.round(delay / 60)),
    kilometers: Number.isFinite(Number(summary.lengthInMeters)) ? Math.round(summary.lengthInMeters / 100) / 10 : null
  };
}

/** clear · slow · heavy, from how much of the trip the delay adds. */
export function trafficLevel({ delayMinutes = 0, freeMinutes = 0 } = {}) {
  if (delayMinutes < 2) return 'clear';
  return delayMinutes >= 15 || delayMinutes > freeMinutes * 0.35 ? 'heavy' : 'slow';
}

export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const rest = total % 60;
  return rest ? `${Math.floor(total / 60)} h ${rest} min` : `${Math.floor(total / 60)} h`;
}

/** What the widget shows next to the arrival time. */
export function describeTraffic(traffic) {
  if (!traffic) return '';
  return traffic.delayMinutes >= 1 ? `+${formatMinutes(traffic.delayMinutes)} traffic` : 'clear roads';
}

/**
 * Live traffic for one route, with a short cache so the widget's periodic
 * refresh cannot burn through the daily free quota.
 */
export function createTrafficSource({ fetchImpl = fetch, baseUrl, now = () => Date.now(), ttlMs = 3 * 60 * 1000, onError = () => {} } = {}) {
  const cache = new Map();
  return async function traffic(key, start, end, mode = 'car') {
    if (!key || !TRAFFIC_MODES.has(mode)) return null;
    const id = `${mode}:${start.latitude},${start.longitude}>${end.latitude},${end.longitude}`;
    const hit = cache.get(id);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    try {
      const response = await fetchImpl(trafficUrl(key, start, end, baseUrl ? { baseUrl } : undefined));
      if (!response.ok) throw new Error(response.status === 403 ? 'the traffic key was refused' : `traffic service answered ${response.status}`);
      const value = parseTraffic(await response.json());
      if (cache.size > 40) cache.clear();
      cache.set(id, { at: now(), value });
      return value;
    } catch (error) {
      onError(error);
      // Keep showing the last known delay for a while rather than flickering.
      return hit?.value ?? null;
    }
  };
}
