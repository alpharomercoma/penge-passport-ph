import { isUnsubscribeToken } from '@penge/contracts';
import type { Api } from '../api.ts';
import { CheckIcon } from '../components/Icons.tsx';
import { TokenAction } from '../components/TokenAction.tsx';
import { BASE } from '../links.ts';

export function Unsubscribe({ api }: { api: Api }) {
  return (
    <>
    <TokenAction
      title="Stop your email alerts"
      intro={<p>Press the button to stop every alert and delete your address from our list.</p>}
      button="Unsubscribe"
      isValid={isUnsubscribeToken}
      act={async (token) => {
        await api.unsubscribe(token);
        return (
          <>
            <CheckIcon />
            <h1>You are unsubscribed</h1>
            <p>
              Your address is deleted, and no more emails will come. The last copies, in our encrypted backups and
              our mail server's logs, are gone within 14 days.
            </p>
            <p>
              <a className="btn btn-secondary" href={BASE}>
                Subscribe again
              </a>
            </p>
          </>
        );
      }}
    />
    <p className="prose">Lost your email link? <a href={`${BASE}delete-data`}>Request a deletion link</a>.</p>
    </>
  );
}
