import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { register, skipRegistration } from './notify/worker.ts';
import './styles.css';
import { takeOwnerLink } from './devices/owner.ts';
import { startTheme } from './theme.ts';

// The theme chosen on an earlier visit, before anything draws.
startTheme();

// Before rendering or registering the worker: the owner link leaves the address bar at once.
const owner = takeOwnerLink();
try {
  if (owner && !owner.kept) sessionStorage.setItem('pengepassportph-owner-unkept', '1');
} catch {
  // Storage refused: the sheet cannot say so, and the link simply is not kept.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App path={window.location.pathname} />
  </StrictMode>,
);

// Lets the installed app open without a connection, and receive pushes (src/sw.js). Dates always come from the network.
if (import.meta.env.PROD) window.addEventListener('load', register);
else skipRegistration();
