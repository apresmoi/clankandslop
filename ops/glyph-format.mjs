export const GLYPH_SHAPES = new Set(['colosseum', 'play', 'notfound', 'satellite', 'pumpjack', 'missile', 'drone', 'chip', 'campfire', 'eclipse']);
export const GLYPH_ROLLS = new Set(['chip', 'eclipse']);

export function glyphFormatFindings(value, name = value?.name) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['glyph must be an object'];
  if (value.name !== name || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(value.name)) errors.push('glyph name must match its filename');
  if (!Number.isSafeInteger(value.cols) || value.cols < 1 || value.cols > 400 || !Number.isSafeInteger(value.rows) || value.rows < 1 || value.rows > 200) errors.push('glyph dimensions must be bounded positive integers');
  for (const key of ['art', ...(value.artDark !== undefined ? ['artDark'] : [])]) {
    const lines = typeof value[key] === 'string' ? value[key].replace(/\n$/u, '').split('\n') : [];
    if (lines.length !== value.rows || lines.some(line => line.length > value.cols || !/^[\x20-\x7e]*$/u.test(line)) || !lines.some(line => /\S/u.test(line))) errors.push(`${key} must be a visible plain ASCII grid within cols and matching rows`);
  }
  return errors;
}

export function glyphSelectionFindings(props) {
  const errors = [];
  if (props?.scale !== undefined && (typeof props.scale !== 'number' || !Number.isFinite(props.scale) || props.scale <= 0 || props.scale > 1))
    errors.push('glyph scale must be a finite number greater than 0 and at most 1');
  if (props?.glyph !== undefined) {
    if (typeof props.glyph !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(props.glyph)) errors.push('glyph must name an edition glyph file');
    if (props.shape !== undefined || props.roll !== undefined) errors.push('a generated glyph cannot also select a shape or roll');
  }
  if (props?.shape !== undefined && !GLYPH_SHAPES.has(props.shape)) errors.push(`glyph shape ${JSON.stringify(props.shape)} has no committed model`);
  if (props?.roll !== undefined && !GLYPH_ROLLS.has(props.roll)) errors.push(`glyph roll ${JSON.stringify(props.roll)} is not committed`);
  if (props?.shape === 'eclipse' && props.roll !== 'eclipse') errors.push('eclipse shape requires roll eclipse');
  if (props?.roll === 'eclipse' && props.shape !== 'eclipse') errors.push('eclipse roll requires shape eclipse');
  return errors;
}
