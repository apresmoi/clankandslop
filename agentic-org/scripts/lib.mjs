import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

export const orgRoot = resolve(import.meta.dirname, '..');
export const policy = JSON.parse(readFileSync(resolve(orgRoot, 'policies/runtime.json'), 'utf8'));
export const agents = ['world-scout', 'klaxon', 'frontier', 'closure', 'cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta', 'brass', 'spike', 'ledger', 'caslon', 'morgue', 'pressman'];
export const sensors = new Set(['world-scout', 'klaxon', 'frontier', 'closure']);
export const reporters = new Set(['cogsworth', 'sprockett', 'foreman', 'graves', 'tinkerton', 'vesta']);
export const digest = /^sha256:[a-f0-9]{64}$/;
export const privateKinds = new Set(policy.privateDirectories);

export function assert(condition, message) { if (!condition) throw new Error(message); }
export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function beneath(root, target) { const rel = relative(resolve(root), resolve(target)); return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes(`${sep}..${sep}`); }
export function safeDirectory(path) { return existsSync(path) && statSync(path).isDirectory(); }
export function releaseFor(edition, offset = '+02:00') { return `${edition}T16:20:00${offset}[Europe/Berlin]`; }
