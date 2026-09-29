// Routing through the public OSRM instances run by FOSSGIS (car, bike, foot).

export const MODES = {
  car: { path: 'routed-car', label: 'Auto' },
  bike: { path: 'routed-bike', label: 'Bici' },
  foot: { path: 'routed-foot', label: 'A piedi' }
};

export function routeUrl(baseUrl, mode, start, end) {
  const profile = MODES[mode] ? mode : 'car';
  return `${baseUrl}/${MODES[profile].path}/route/v1/driving/${start.longitude},${start.latitude};${end.longitude},${end.latitude}?overview=full&geometries=geojson&steps=true`;
}

const SIDE = { left: 'a sinistra', right: 'a destra', 'slight left': 'leggermente a sinistra', 'slight right': 'leggermente a destra', 'sharp left': 'decisamente a sinistra', 'sharp right': 'decisamente a destra', straight: 'dritto', uturn: 'con inversione' };

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '';
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} km`;
}

export function instruction(step) {
  const { type, modifier, exit } = step.maneuver || {};
  const name = step.name || step.ref || '';
  const onto = name ? ` in ${name}` : '';
  const side = SIDE[modifier] || '';
  switch (type) {
    case 'depart': return name ? `Parti da ${name}` : 'Parti';
    case 'arrive': return 'Sei arrivato a destinazione';
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn': return `Alla rotonda prendi la ${exit ? `${exit}ª` : ''} uscita${name ? ` verso ${name}` : ''}`.replace('la  uscita', "l'uscita");
    case 'exit roundabout':
    case 'exit rotary': return `Esci dalla rotonda${onto}`;
    case 'merge': return `Immettiti${onto || ' nella corsia'}`;
    case 'on ramp': return `Prendi la rampa${side && side !== 'dritto' ? ` ${side}` : ''}${name ? ` per ${name}` : ''}`;
    case 'off ramp': return `Prendi l'uscita${side && side !== 'dritto' ? ` ${side}` : ''}${name ? ` verso ${name}` : ''}`;
    case 'fork': return `Al bivio tieni ${side || 'la direzione'}${onto}`;
    case 'end of road': return `A fine strada svolta ${side || ''}${onto}`.replace('  ', ' ');
    case 'new name':
    case 'continue': return modifier && modifier !== 'straight' ? `Tieni ${side}${onto}` : `Continua${onto || ' dritto'}`;
    case 'turn':
    default:
      if (modifier === 'straight') return `Prosegui dritto${onto}`;
      if (modifier === 'uturn') return `Fai inversione${onto}`;
      return `Svolta ${side || ''}${onto}`.trim();
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
