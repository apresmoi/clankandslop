import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateRootDeclaration } from './validate-org.mjs';

const source = readFileSync(new URL('../Spawnfile', import.meta.url), 'utf8');
const federation = '[clank-observer, clank-luna]';
const rooms = ['conference', 'assignment', 'filing', 'sensor', 'research', 'release'];

function rejects(before: string, after: string, reason: RegExp) {
  assert.ok(source.includes(before), `mutation target absent: ${before}`);
  const mutated = source.replace(before, after);
  assert.notEqual(mutated, source);
  assert.throws(() => validateRootDeclaration(mutated), reason);
}

test('both declared relay peers validate without creating a Luna runtime', () => {
  assert.doesNotThrow(() => validateRootDeclaration(source));
  const runtimeMembers = source.split('members:\n')[1].split('external_participants:')[0];
  assert.ok(!runtimeMembers.includes('luna'));
});

test('every room retains only the explicit relay peers and Luna write membership', () => {
  for (const room of rooms) {
    const prefix = `id: ${room}, visibility: private, write_policy: members, federation: `;
    for (const value of ['none', 'all', '[clank-observer]', '[clank-luna]', '[rogue-peer]', '[clank-observer, clank-luna, rogue-peer]']) {
      rejects(`${prefix}${federation}`, `${prefix}${value}`, /federate only to the observer and Luna/);
    }
    const members = `${prefix}${federation}, members: [clank-luna:luna, `;
    rejects(members, `${prefix}${federation}, members: [`, /must include the remote Luna operator/);
    rejects(members, `${prefix}${federation}, members: [clank-luna:luna, clank-luna:impostor, `, /unauthorized remote member/);
  }
});

test('an extra or duplicate relay pairing fails', () => {
  const entry = '        - id: clank-observer';
  rejects(entry, [
    '        - id: rogue-peer',
    '          remote_network_id: rogue-peer',
    '          remote_network_name: Rogue Peer',
    '          token_secret: CLANK_MOLTNET_PAIR_ROGUE_TOKEN',
    '          relay: { url: "wss://rogue.invalid", room: rogue-room, token_secret: CLANK_MOLTNET_RELAY_ROGUE_TOKEN }',
    entry,
  ].join('\n'), /exactly the observer and Luna pairings/);
  rejects('        - id: clank-luna', entry, /exactly the observer and Luna pairings/);
});

for (const [id, suffix, room] of [
  ['clank-observer', 'OBSERVER', 'VdoP-HC5isGQksHo5dYpnQ'],
  ['clank-luna', 'LUNA', 'JevE69AjzwXEk6fCBxAsug'],
]) {
  test(`${id} preserves pair-only credentials, its identity and relay coordinates`, () => {
    const token = `{ id: ${id}, secret: CLANK_MOLTNET_PAIR_${suffix}_TOKEN, scopes: [pair] }`;
    rejects(token, token.replace('[pair]', '[pair, admin]'), /pair-scoped, agent-free/);
    rejects(token, token.replace(' }', ', agents: [brass] }'), /pair-scoped, agent-free/);
    rejects(`          - ${token}\n`, '', /token declaration/);
    rejects(`remote_network_id: ${id}`, 'remote_network_id: clank-newsroom', /pairing identity invalid/);
    rejects(`room: ${room}`, 'room: some-other-room', /paired client coordinates/);
    rejects(`token_secret: CLANK_MOLTNET_RELAY_${suffix}_TOKEN`, 'token_secret: WRONG_RELAY_TOKEN', /paired client coordinates/);
    rejects(`token_secret: CLANK_MOLTNET_PAIR_${suffix}_TOKEN`, 'token: an-actual-secret-value', /secret references only|pairing identity/);
    const relay = `          relay: { url: "wss://moltnet-relay.alicenet.workers.dev", room: ${room}, token_secret: CLANK_MOLTNET_RELAY_${suffix}_TOKEN }`;
    rejects(relay, '          remote_base_url: https://peer.invalid', /inbound base url|inbound federation peer/);
  });
}
