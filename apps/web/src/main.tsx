import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { BASE } from './links.ts';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App path={window.location.pathname} />
  </StrictMode>,
);

// Lets the installed app open without a connection (src/sw.js). Dates always come from the network.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch(() => undefined);
  });
}
