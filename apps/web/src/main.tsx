import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { register, skipRegistration } from './notify/worker.ts';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App path={window.location.pathname} />
  </StrictMode>,
);

// Lets the installed app open without a connection, and receive pushes (src/sw.js). Dates always come from the network.
if (import.meta.env.PROD) window.addEventListener('load', register);
else skipRegistration();
