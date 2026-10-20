/// <reference types="vite/client" />
// Registers the service worker (production builds only; the dev server has no worker file). A worker that replaces a
// running one means a new player build: the page reloads once so the display runs the new code.

const UPDATE_CHECK_MS = 6 * 3_600_000;

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const hadController = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  const register = () => {
    navigator.serviceWorker
      .register('/player/sw.js', { scope: '/player/', updateViaCache: 'none' })
      .then((registration) => {
        setInterval(() => {
          void registration.update().catch(() => undefined);
        }, UPDATE_CHECK_MS);
      })
      .catch(() => undefined);
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
