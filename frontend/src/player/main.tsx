import { createRoot } from 'react-dom/client';
import { createPlayerApi } from './api';
import { FatalBoundary, PlayerApp } from './PlayerApp';
import './player.css';

createRoot(document.getElementById('root')!).render(<FatalBoundary><PlayerApp api={createPlayerApi()} /></FatalBoundary>);
