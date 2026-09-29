import { isToken } from '@penge/contracts';
import type { Api } from '../api.ts';
import { CheckIcon } from '../components/Icons.tsx';
import { TokenAction } from '../components/TokenAction.tsx';
import { BASE } from '../links.ts';
import { plural } from '../office.ts';

export function Confirm({ api }: { api: Api }) {
  return (
    <TokenAction
      title="Confirm your email alert"
      intro={<p>Press the button to start getting an email when a date opens at the offices you picked.</p>}
      button="Confirm email alert"
      isValid={isToken}
      act={async (token) => {
        const r = await api.confirm(token);
        return (
          <>
            <CheckIcon />
            <h1>{r.status === 'updated' ? 'Your alert is updated' : 'You are subscribed'}</h1>
            <p>
              We will email you when a date opens at {plural(r.siteIds.length, 'office')}, for{' '}
              {r.applicants === 1 ? 'one person' : `${r.applicants} people`},{' '}
              {r.pace === 'asap' ? 'as soon as a check finds dates' : 'at most once an hour'}.
            </p>
            <p>
              <a className="btn btn-secondary" href={BASE}>
                See open dates now
              </a>
            </p>
          </>
        );
      }}
    />
  );
}
