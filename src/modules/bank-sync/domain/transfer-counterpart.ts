// An OUT leg naming its counterpart waits for the IN leg to post the transfer. See memory/bank-sync.md.
export const TRANSFER_AWAITING_PEER = 'TRANSFER_AWAITING_PEER';

const ACCOUNT = /^\d{6,19}$/;
const MAX_CANDIDATES = 20;

/**
 * Digit runs that could be the other account of a transfer, plus adjacent runs
 * joined across one space (`10 17013153`). See memory/bank-sync.md.
 */
export function accountCandidates(text: string): string[] {
  const runs = [...text.normalize('NFC').matchAll(/\d+/g)];
  const out = new Set<string>();
  runs.forEach((run, i) => {
    if (ACCOUNT.test(run[0])) out.add(run[0]);
    const next = runs[i + 1];
    if (!next) return;
    const gap = text.slice(run.index + run[0].length, next.index);
    const joined = run[0] + next[0];
    if (/^\s$/.test(gap) && ACCOUNT.test(joined)) out.add(joined);
  });
  return [...out].slice(0, MAX_CANDIDATES);
}
