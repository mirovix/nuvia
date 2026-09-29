// Routing through the public OSRM instances run by FOSSGIS (car, bike, foot).

export const MODES = {
  car: { path: 'routed-car', label: 'Car' },
  bike: { path: 'routed-bike', label: 'Bike' },
  foot: { path: 'routed-foot', label: 'Walk' }
};

export function routeUrl(baseUrl, mode, start, end) {
  const profile = MODES[mode] ? mode : 'car';
  return `${baseUrl}/${MODES[profile].path}/route/v1/driving/${start.longitude},${start.latitude};${end.longitude},${end.latitude}?overview=full&geometries=geojson&steps=true`;
}

const SIDE = { left: 'left', right: 'right', 'slight left': 'slightly left', 'slight right': 'slightly right', 'sharp left': 'sharp left', 'sharp right': 'sharp right', straight: 'straight', uturn: 'around' };

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })} km`;
}

export function ordinal(value) {
  const n = Number(value);
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
}

export function instruction(step) {
  const { type, modifier, exit } = step.maneuver || {};
  const name = step.name || step.ref || '';
  const onto = name ? ` onto ${name}` : '';
  const toward = name ? ` toward ${name}` : '';
  const side = SIDE[modifier] || '';
  const lateral = side && modifier !== 'straight' && modifier !== 'uturn' ? ` on the ${side.replace(/^(slightly|sharp) /, '')}` : '';
  switch (type) {
    case 'depart': return name ? `Head out on ${name}` : 'Head out';
    case 'arrive': return 'You have arrived';
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn': return `At the roundabout, take the ${exit ? `${ordinal(exit)} ` : ''}exit${onto}`;
    case 'exit roundabout':
    case 'exit rotary': return `Exit the roundabout${onto}`;
    case 'merge': return name ? `Merge onto ${name}` : 'Merge';
    case 'on ramp': return `Take the ramp${lateral}${toward}`;
    case 'off ramp': return `Take the exit${lateral}${toward}`;
    case 'fork': return `At the fork, keep ${side && modifier !== 'straight' ? side : 'straight'}${onto}`;
    case 'end of road': return side && modifier !== 'straight' ? `At the end of the road, turn ${side}${onto}` : `At the end of the road, continue${onto}`;
    case 'new name':
    case 'continue': return modifier && modifier !== 'straight' && modifier !== 'uturn' ? `Keep ${side}${onto}` : modifier === 'uturn' ? `Make a U-turn${onto}` : `Continue${onto || ' straight'}`;
    case 'turn':
    default:
      if (modifier === 'straight') return `Continue straight${onto}`;
      if (modifier === 'uturn') return `Make a U-turn${onto}`;
      return side ? `Turn ${side}${onto}` : `Continue${onto}`;
  }
}

export function summarizeRoute(json) {
  const route = json?.routes?.[0];
  if (!route) return null;
  const steps = route.legs.flatMap(leg => leg.steps || [])
    .filter(step => step.maneuver && (step.distance > 0 || step.maneuver.type === 'arrive'))
    .map(step => ({ text: instruction(step), distance: formatDistance(step.distance), meters: step.distance, type: step.maneuver.type, modifier: step.maneuver.modifier || '' }));
  return {
    minutes: Math.max(1, Math.round(route.duration / 60)),
    kilometers: Math.round(route.distance / 100) / 10,
    geometry: route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]),
    steps
  };
}
