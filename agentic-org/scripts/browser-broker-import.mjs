import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isBerlinRelease } from './release-time.mjs';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const editionPattern = /^\d{4}-\d{2}-\d{2}$/;
const idPattern = /^[a-z0-9-]{6,80}$/;
const deskPattern = /^[a-z][a-z0-9-]{1,79}$/;
const keys = value => Object.keys(value).sort().join();
const exact = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && keys(value) === [...expected].sort().join();
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const stable = value => `${JSON.stringify(value)}\n`;

export function validateBrowserBrokerResult(value) {
  if (!exact(value, ['version', 'request_id', 'health', 'sources']) || value.version !== 'v1' || !idPattern.test(value.request_id) || !['ok', 'degraded', 'unavailable'].includes(value.health) || !Array.isArray(value.sources)) throw new Error('browser-broker result does not match the v1 result schema');
  for (const source of value.sources) {
    const retrieved = typeof source.retrieved_at === 'string' ? Date.parse(source.retrieved_at) : Number.NaN;
    if (!exact(source, ['url', 'retrieved_at', 'capture_digest', 'private_locator']) || !URL.canParse(source.url) || Number.isNaN(retrieved) || new Date(retrieved).toISOString() !== source.retrieved_at || !digestPattern.test(source.capture_digest) || typeof source.private_locator !== 'string' || !source.private_locator.startsWith('private:')) throw new Error('browser-broker source does not match the v1 result schema');
  }
  return value;
}

async function converge(file, bytes) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const current = await readFile(file, 'utf8');
    if (current !== bytes) throw new Error('browser-broker promotion conflict');
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, file); } catch (error) {
    if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== bytes) throw error;
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function importBrowserBrokerResult({ edition, release, result, selectedDesks, stateRoot }) {
  validateBrowserBrokerResult(result);
  if (!editionPattern.test(edition) || !isBerlinRelease(edition, release) || !Array.isArray(selectedDesks) || selectedDesks.length === 0 || selectedDesks.some(desk => !deskPattern.test(desk)) || new Set(selectedDesks).size !== selectedDesks.length) throw new Error('browser-broker promotion metadata invalid');
  if (result.health !== 'ok' || result.sources.length === 0) throw new Error('browser-broker result is not promotable');
  const sourceEvidence = result.sources.map(({ url, retrieved_at, capture_digest, private_locator }) => ({ url, retrieved_at, capture_digest, private_locator }));
  const evidenceDigest = sha(stable({ request_id: result.request_id, sources: sourceEvidence }));
  const occurrenceId = `sensor-${createHash('sha256').update(`${edition}\0${result.request_id}\0${evidenceDigest}`).digest('hex').slice(0, 48)}`;
  const record = { version: 'v1', kind: 'browser-broker.promotion', occurrence_id: occurrenceId, edition, release, correlation_id: `broker-${createHash('sha256').update(result.request_id).digest('hex').slice(0, 32)}`, selected_desks: [...selectedDesks].sort(), request_id: result.request_id, evidence_digest: evidenceDigest, sources: sourceEvidence };
  const root = resolve(stateRoot);
  await converge(join(root, 'promotions', `${occurrenceId}.json`), stable(record));
  const end = new Date(release.replace('[Europe/Berlin]','')), start = new Date(end.getTime() - 4 * 60 * 60 * 1000);
  const leads = sourceEvidence.map((source,index)=>`${index+1}. Verify and rank ${source.url} (captured ${source.retrieved_at}); gap: corroborate the primary claim and material change.`).join('\n');
  const text = `Klaxon research handoff for ${edition}.\nRolling window: ${start.toISOString()} through ${end.toISOString()} (Berlin release ${release}).\nSelected desks: ${[...selectedDesks].sort().join(', ')}.\n${leads}\nProvenance: artifact ${occurrenceId}; ${evidenceDigest}; event_key ${occurrenceId}.`;
  if(Buffer.byteLength(text)>2048)throw new Error('browser-broker handoff exceeds Moltnet limit');
  return { record, sensor: { version: 'v1', id: occurrenceId, sender: 'research-sensor', kind: 'browser-broker.promoted', target:'dm:klaxon', text } };
}
