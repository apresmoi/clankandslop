#!/usr/bin/env node
// The `--notify-command` of clank-release.service: `spawnfile release` runs it
// (no shell, no arguments) with a spawnfile.release-notification.v1 JSON on
// stdin whenever a release fails, and once when one has been deferred too long.
//
// It does not invent a channel. It hands the notification to alarm.mjs, the
// same recorder cycle-audit uses: the breadcrumb lands in the alarm spool
// first, then goes to CLANK_ALARM_URL when one is configured. Production has no
// URL, so the spool IS the delivery target there, and a written breadcrumb is
// what exit 0 means.
//
// Exit 0: recorded (and delivered, when a channel exists). 75: recorded, channel
// configured but not delivered. 64: the notification could not be read.
import { raise } from './alarm.mjs';

export const NOTIFICATION_VERSION = 'spawnfile.release-notification.v1';

/** Spawnfile's reason words onto alarm.mjs's fixed vocabulary; the exact word stays in the message. */
export function alarmFor(notification) {
  if (notification?.version !== NOTIFICATION_VERSION || typeof notification.reason !== 'string' || typeof notification.message !== 'string')
    throw new Error(`expected a ${NOTIFICATION_VERSION} notification on stdin`);
  const reason = notification.reason === 'release-deferred' ? 'release-deferred' : 'deploy-failed';
  const identity = notification.identity ? ` (${String(notification.identity).slice(0, 19)})` : '';
  return { reason, message: `spawnfile release ${notification.reason}${identity}: ${notification.message}` };
}

export async function notify(input, { environment = process.env, log = console.log } = {}) {
  const alarm = alarmFor(JSON.parse(input));
  const result = await raise({ ...alarm, edition: null, detailFile: null, selftest: false, dryRun: false }, { environment, log });
  return result.delivered || result.channel === false ? 0 : 75;
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  readStdin()
    .then((input) => notify(input))
    .then((code) => { process.exitCode = code; })
    .catch((error) => { process.stderr.write(`release-notify: ${error.message}\n`); process.exitCode = 64; });
}
