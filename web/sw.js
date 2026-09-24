const CACHE='bka-v120-pwa';
const ASSETS=[
  './','./index.html','./styles.css','./app.js','./engine.js','./loyalty.js','./bootstrap-data.js','./campaign-browser.js',
  './cloud-sync.js','./runtime-config.js','./manifest.webmanifest','./data/catalog.json',
  './icons/icon-192.png','./icons/icon-512.png','./icons/maskable-192.png','./icons/maskable-512.png'
];
self.addEventListener('install',e=>{ self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const u=new URL(e.request.url);
  if(u.pathname.startsWith('/api/') || u.hostname.includes('supabase.co')) { e.respondWith(fetch(e.request)); return; }
  if(e.request.mode==='navigate') {
    e.respondWith(fetch(e.request).then(r=>{ const copy=r.clone(); caches.open(CACHE).then(c=>c.put('./index.html',copy)); return r; }).catch(()=>caches.match('./index.html')));
    return;
  }
  e.respondWith(fetch(e.request).then(r=>{ if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));} return r; }).catch(()=>caches.match(e.request)));
});
