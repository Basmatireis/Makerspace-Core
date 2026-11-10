import { createRoot } from 'react-dom/client';
import { createEmbedApi, createPlayerApi } from './api';
import { embedKeyFromPath } from './embed';
import { EmbedApp, FatalBoundary, PlayerApp } from './PlayerApp';
import { registerServiceWorker } from './register';
import './player.css';

// /embed/{key} is a web embed: public API, no pairing and no service worker. Everything else is the device player.
const embedKey = embedKeyFromPath(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <FatalBoundary>
    {embedKey ? <EmbedApp api={createEmbedApi(embedKey)} /> : <PlayerApp api={createPlayerApi()} />}
  </FatalBoundary>,
);
if (!embedKey) registerServiceWorker();
