/* ════════════════════════════════════════════════════════════
   Benedictus Camisaria · Admin — Service Worker
   ────────────────────────────────────────────────────────────
   Estratégia: NETWORK-FIRST + auto-atualização agressiva.
   - Sempre tenta o servidor primeiro (mostra código novo).
   - Cache só é usado como fallback offline.
   - CACHE_VERSION é INJETADO automaticamente pelo Netlify
     durante o build (via netlify.toml).
   - Em desenvolvimento local, fica com '__BUILD_ID__' literal,
     o que é OK — cada arquivo modificado já dispara update.
   ════════════════════════════════════════════════════════════ */

// Placeholder substituído automaticamente pelo Netlify a cada deploy.
// NÃO editar manualmente — o sed do netlify.toml troca por COMMIT_REF.
const CACHE_VERSION = 'benedictus-admin-__BUILD_ID__';

const SHELL = [
  './admin.html',
  './adminsenha.html',
  './manifest.json',
  './WhatsApp_Image_2026-04-24_at_07.27.00__1_-removebg-preview.png'
];

// Instalação — pré-cacheia o shell e ATIVA IMEDIATAMENTE
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => {/* ignora falhas individuais */}))
      .then(() => self.skipWaiting()) // não espera abas antigas — assume já
  );
});

// Ativação — limpa TODOS os caches antigos e toma controle imediato
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
    // Avisa todas as abas que houve atualização — elas vão recarregar
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }));
  })());
});

// Fetch — NETWORK-FIRST. Sempre tenta o servidor; cache só se offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Nunca interceptar chamadas externas (Supabase, fontes, CDNs)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((response) => {
        // Atualiza cache do shell em background
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(req, clone)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(req).then(c => c || caches.match('./adminsenha.html')))
  );
});

// Permite que a página force atualização imediata
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});