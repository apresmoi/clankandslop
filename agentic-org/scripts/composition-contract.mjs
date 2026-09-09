import { createHash } from 'node:crypto';

const slug = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const hex = /^[a-f0-9]{64}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const compositionArtifactSchema = {
  type: 'object', additionalProperties: false, required: ['kind', 'name', 'sha256'],
  properties: {
    kind: { type: 'string', enum: ['map', 'glyph'] },
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,127}$' },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Exact immutable artifact digest returned by the Caslon artwork tool.' }
  }
};

export function validateCompositionArtifact(reference, bytes, provenance) {
  if (!object(reference) || Object.keys(reference).sort().join() !== 'kind,name,sha256' || !['map', 'glyph'].includes(reference.kind) || !slug.test(reference.name) || !hex.test(reference.sha256)) throw new Error('invalid composition artifact reference');
  if (typeof bytes !== 'string' || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) throw new Error('composition artifact digest mismatch');
  if (!object(provenance) || provenance.version !== 'clank.artifact.v1' || provenance.kind !== reference.kind || provenance.sha256 !== reference.sha256 || provenance.provenance?.actor !== 'caslon') throw new Error('composition artifact provenance mismatch');
  const artifact = JSON.parse(bytes);
  if (!object(artifact) || artifact.name !== reference.name) throw new Error('composition artifact name mismatch');
  if (!Number.isSafeInteger(artifact.cols) || artifact.cols < 1 || artifact.cols > 400 || !Number.isSafeInteger(artifact.rows) || artifact.rows < 1 || artifact.rows > 200) throw new Error('composition artifact grid is invalid');
  if (reference.kind === 'map') {
    if (artifact.rows > 48 || ![artifact.west, artifact.east, artifact.south, artifact.north].every(Number.isFinite) || artifact.west < -180 || artifact.east > 180 || artifact.south < -90 || artifact.north > 90 || artifact.west >= artifact.east || artifact.south >= artifact.north) throw new Error('composition map bounds or row count is invalid');
    if (!Array.isArray(artifact.bands) || artifact.bands.length !== artifact.rows || artifact.bands.some(row => typeof row !== 'string' || row.length !== artifact.cols || !/^[0-8]+$/u.test(row))) throw new Error('composition map band grid is invalid');
  } else {
    const lines = typeof artifact.art === 'string' ? artifact.art.split('\n') : [];
    if (lines.length !== artifact.rows || lines.some(line => line.length !== artifact.cols || !/^[\x20-\x7e]+$/u.test(line)) || !lines.some(line => /\S/u.test(line))) throw new Error('composition glyph grid is invalid');
  }
  return artifact;
}
