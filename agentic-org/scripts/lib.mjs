import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

export const orgRoot = resolve(import.meta.dirname, '..');
export const policy = JSON.parse(readFileSync(resolve(orgRoot, 'policies/runtime.json'), 'utf8'));
export const agents = ['klaxon', 'cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta', 'brass', 'spike', 'ledger', 'caslon', 'pressman'];
export const sensors = new Set(['klaxon']);
export const reporters = new Set(['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta']);
export const digest = /^sha256:[a-f0-9]{64}$/;
export const privateKinds = new Set(policy.privateDirectories);
export const declaredMoltnetSecretRefs = Object.freeze([...readFileSync(resolve(orgRoot, 'Spawnfile'), 'utf8').matchAll(/\b(?:secret|token_secret):\s*([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]));

export function assert(condition, message) { if (!condition) throw new Error(message); }
export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function beneath(root, target) { const rel = relative(resolve(root), resolve(target)); return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes(`${sep}..${sep}`); }
export function safeDirectory(path) { return existsSync(path) && statSync(path).isDirectory(); }
export function releaseFor(edition, offset = '+02:00') { return `${edition}T16:00:00${offset}[Europe/Berlin]`; }
