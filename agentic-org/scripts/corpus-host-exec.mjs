// The one place the host writer shells out, split out of corpus-volume.mjs so
// that the CORPUS.json publisher (corpus-volume-identity.mjs) can share it
// without the two modules importing each other. corpus-volume.mjs re-exports
// `hostExec`, so every caller keeps importing it from there.

import { execFileSync } from 'node:child_process';

// Every external command the host writer runs, in one place, so a test can watch
// exactly which trees were chowned and frozen.
//
// stdin is 'ignore' EXCEPT when the caller pipes bytes in: `stdio[0]: 'ignore'`
// silently wins over `input`, and `tar -x` then extracts nothing and exits 0 --
// a staged corpus that is simply empty, with no error anywhere to say so.
export const hostExec = (command, args, options = {}) => execFileSync(command, args, {
  maxBuffer: 1024 * 1024 * 1024, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...options
});
