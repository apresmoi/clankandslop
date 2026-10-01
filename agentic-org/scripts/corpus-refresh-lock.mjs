// The flock(2) relay that makes the host-side corpus refresher a single writer.
//
// Split out of corpus-refresh.mjs, which re-exports all of it: re-executing the
// run under flock(1) is a process-management concern with nothing to say about
// whether a refresh is needed. `main` there is what decides to call it, and the
// essay below is why it cannot be done any other way.

import { CorpusError } from './corpus-contract.mjs';

const fail = (message) => { throw new CorpusError(message); };

// ONE WRITER AT A TIME, AND IT HAS TO BE flock(2)
// ----------------------------------------------
// The refresher runs every couple of minutes; the epoch roll and the release
// job already serialize against it with `/usr/bin/flock
// /run/lock/clank-corpus-refresh.lock ...` in their units. Two refreshers
// racing would be survivable -- content is addressed by commit -- but a
// refresher racing a container recreate is a container reading the volume while
// its entries move, and the startup guard aborts on exactly that.
//
// So the lock has to be the SAME lock those units take, which is a real
// flock(2) on that path. Node cannot take one without a native addon, and a
// pidfile on the same path would be invisible to them and they to it -- mutual
// exclusion that only one side observes is worse than none, because it reads as
// protection. The whole run therefore re-executes under flock(1), once, marked
// by an environment variable so the child does not do it again.
export const LOCK_BUSY_EXIT = 69;
export const LOCK_ENV = 'CLANK_CORPUS_LOCK_HELD';

export function relayUnderLock(options, argv, { env, spawn, script, log }) {
  const relay = spawn('flock', ['-n', '-E', String(LOCK_BUSY_EXIT), options.lock, process.execPath, script, ...argv], {
    stdio: 'inherit', env: { ...env, [LOCK_ENV]: options.lock }
  });
  // A missing or broken flock(1) is a refusal: running unlocked would be a
  // refresh that can interleave with a container recreate, which is the one
  // failure this lock exists to prevent.
  if (relay.error) fail(`could not take the corpus lock ${options.lock} with flock(1): ${relay.error.message}`);
  if (relay.status === LOCK_BUSY_EXIT) { log(`another corpus writer holds ${options.lock}; nothing to do`); return 0; }
  if (relay.signal) fail(`the locked corpus refresh was killed by ${relay.signal}`);
  return relay.status ?? 1;
}
