import type { ReactNode } from 'react';
import { type Api, api as realApi } from './api.ts';
import { LogoMark } from './components/Logo.tsx';
import { BASE, BOOKING_URL, REPO_URL, routeOf } from './links.ts';
import { Confirm } from './pages/Confirm.tsx';
import { Home } from './pages/Home.tsx';
import { Unsubscribe } from './pages/Unsubscribe.tsx';

function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a className="brand" href={BASE} aria-label="PengePassportPH home">
          <LogoMark />
          <span>
            PengePassport<span className="brand-ph">PH</span>
          </span>
        </a>
      </header>
      <main id="main">{children}</main>
      <footer className="site-footer">
        <p>
          PengePassportPH is a free, unofficial project, not run by or affiliated with the Department of Foreign Affairs.
          It reads the public calendar and never books, holds or reserves a slot. Appointments are booked, for free, at{' '}
          <a href={BOOKING_URL} rel="noreferrer">
            passport.gov.ph
          </a>
          .
        </p>
        <p>
          <a href={REPO_URL} rel="noreferrer">
            Source code
          </a>
          , MIT license.
        </p>
      </footer>
    </>
  );
}

function NotFound() {
  return (
    <section className="panel">
      <h1>This page does not exist</h1>
      <p>
        <a className="btn btn-primary" href={BASE}>
          See open appointment dates
        </a>
      </p>
    </section>
  );
}

export function App({ path, api = realApi }: { path: string; api?: Api }) {
  const route = routeOf(path);
  return (
    <Layout>
      {route === '/' ? (
        <Home api={api} />
      ) : route === '/confirm' ? (
        <Confirm api={api} />
      ) : route === '/unsubscribe' ? (
        <Unsubscribe api={api} />
      ) : (
        <NotFound />
      )}
    </Layout>
  );
}
