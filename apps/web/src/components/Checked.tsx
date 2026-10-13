import { ago, manilaClock } from '../time.ts';

/**
 * When something was checked: its age, then the time in Manila ("5 minutes ago · 2:36 PM PHT"). `fresh` highlights both
 * in the open colour, for what is current; a time kept from an earlier check (an office whose latest one failed, a
 * date that closed) stays plain.
 */
export function Checked({ at, fresh = false }: { at: string; fresh?: boolean }) {
  const cls = fresh ? 'fresh' : undefined;
  return (
    <>
      <time className={cls} dateTime={at}>
        {ago(at)}
      </time>{' '}
      · <span className={cls}>{manilaClock(at)}</span>
    </>
  );
}
