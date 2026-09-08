const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const colors = new Set(['accent', 'red', 'green']);
export const MAP_PRESENTATION_FIELDS = Object.freeze(['title', 'caption', 'spots', 'routes', 'overlays', 'tone', 'locator_context']);

// New Caslon maps use the existing print vocabulary; archived reporter art is frozen.
export function mapPresentationFindings(choice, map) {
  const errors = [];
  if (!object(choice) || !object(map)) return ['map presentation and terrain are required'];
  if (!Number.isInteger(map.cols) || map.cols < 84 || !Number.isInteger(map.rows) || map.rows < 32 || map.rows > 48)
    errors.push('map source grid must have at least 84 columns and 32–48 rows; use the catalogue default 140×48, not Hero display dimensions');
  if (!text(choice.caption)) errors.push('map caption is required');
  if (choice.title !== undefined && !text(choice.title)) errors.push('map title must be nonempty');
  if (!['regional', 'continental'].includes(choice.locator_context)) errors.push('map locator_context must be regional or continental');
  if (choice.tone !== undefined && !['normal', 'soft'].includes(choice.tone)) errors.push('map tone must be normal or soft');
  for (const key of Object.keys(choice)) if (!['artifact', ...MAP_PRESENTATION_FIELDS].includes(key)) errors.push(`unsupported map choice field: ${key}`);
  const coordinate = (lat, lon, where) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push(`${where} must use finite latitude/longitude coordinates`); return;
    }
    if (lat <= map.south || lat >= map.north || lon <= map.west || lon >= map.east) errors.push(`${where} falls outside the map interior; widen the crop or correct the coordinate`);
  };
  if (!Array.isArray(choice.spots) || choice.spots.length < 1 || choice.spots.length > 20) errors.push('map spots must contain 1–20 named places from the story geography');
  else {
    const names = new Set();
    for (const [i, spot] of choice.spots.entries()) {
      if (!object(spot)) { errors.push(`spots[${i}] must be an object`); continue; }
      if (!text(spot.name) || names.has(spot.name)) errors.push(`spots[${i}] needs a unique nonempty name`);
      names.add(spot.name);
      coordinate(spot.lat, spot.lon, `spots[${i}]`);
      if (spot.label_side !== undefined && !['left', 'right'].includes(spot.label_side)) errors.push(`spots[${i}].label_side must be left or right`);
      if (spot.label_dy !== undefined && (!Number.isFinite(spot.label_dy) || Math.abs(spot.label_dy) > 100)) errors.push(`spots[${i}].label_dy must be between -100 and 100`);
    }
  }
  for (const [field, geometry, minimum] of [['routes', 'points', 2], ['overlays', 'ring', 3]]) {
    if (choice[field] === undefined) continue;
    if (!Array.isArray(choice[field]) || choice[field].length > 12) { errors.push(`${field} must be an array with at most 12 entries`); continue; }
    for (const [i, item] of choice[field].entries()) {
      if (!object(item)) { errors.push(`${field}[${i}] must be an object`); continue; }
      if (!text(item.name)) errors.push(`${field}[${i}].name is required for the map key`);
      if (item.color !== undefined && !colors.has(item.color)) errors.push(`${field}[${i}].color must use the house palette`);
      if (!Array.isArray(item[geometry]) || item[geometry].length < minimum || item[geometry].length > 200) {
        errors.push(`${field}[${i}].${geometry} requires ${minimum}–200 coordinate pairs`); continue;
      }
      for (const [j, point] of item[geometry].entries()) {
        if (!Array.isArray(point) || point.length !== 2) errors.push(`${field}[${i}].${geometry}[${j}] must be [lat, lon]`);
        else coordinate(point[0], point[1], `${field}[${i}].${geometry}[${j}]`);
      }
    }
  }
  return errors;
}

export function mapPresentationProps(choice) {
  return Object.fromEntries(MAP_PRESENTATION_FIELDS.filter(key => choice[key] !== undefined).map(key => [key, structuredClone(choice[key])]));
}
