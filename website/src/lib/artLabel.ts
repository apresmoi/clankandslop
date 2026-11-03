/** Glyph art is text, so a screen reader would spell out every character.
    Each raster is aria-hidden; its container is role="img" with one of these
    names instead. */
const named = (items: Array<{ name?: string }>) => items.map((i) => i.name).filter((n): n is string => !!n);

const list = (xs: string[]) =>
  xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

export function mapLabel(opts: {
  /** The map's title; slugs are not names, so without one the label lists only what is marked. */
  place?: string;
  spots?: Array<{ name?: string }>;
  overlays?: Array<{ name?: string }>;
  routes?: Array<{ name?: string }>;
}): string {
  const parts = [opts.place ? `Map of ${opts.place}` : 'Map'];
  const spots = named(opts.spots ?? []);
  const zones = named(opts.overlays ?? []);
  const routes = named(opts.routes ?? []);
  if (spots.length) parts.push(`Marked: ${list(spots)}`);
  if (zones.length) parts.push(`Shaded: ${list(zones)}`);
  if (routes.length) parts.push(`${routes.length > 1 ? 'Routes' : 'Route'}: ${list(routes)}`);
  return parts.join('. ') + '.';
}

export function globeLabel(hotspots: Array<{ name?: string }>): string {
  const names = named(hotspots);
  return names.length
    ? `Rotating globe marking ${names.length} flashpoint${names.length > 1 ? 's' : ''}: ${list(names)}.`
    : 'Rotating globe.';
}
