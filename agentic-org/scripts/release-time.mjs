import schedule from '../policies/schedule.json' with { type: 'json' };

export const releaseClock = edition => edition < schedule.effective_from ? schedule.previous_deadline : schedule.deadline;

const editionPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export function isBerlinRelease(edition, release) {
  const match = typeof edition === 'string' ? edition.match(editionPattern) : null;
  if (!match || typeof release !== 'string') return false;
  const [year, month, day] = match.slice(1).map(Number);
  const clock = releaseClock(edition), [hour, minute] = clock.split(':').map(Number);
  for (const [offset, hours] of [['+01:00', 1], ['+02:00', 2]]) {
    const instant = new Date(Date.UTC(year, month - 1, day, hour - hours, minute));
    const parts = Object.fromEntries(formatter.formatToParts(instant).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
    if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` === `${edition}T${clock}:00` && release === `${edition}T${clock}:00${offset}[Europe/Berlin]`) return true;
  }
  return false;
}
