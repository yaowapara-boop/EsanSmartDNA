/* Service worker: ให้เปิดหน้าเว็บได้เร็วและเปิดได้แม้ออฟไลน์
 * - เก็บเฉพาะไฟล์ของเว็บเอง (same-origin GET)
 * - ไม่เก็บ/ไม่ยุ่งกับการส่งแบบฟอร์ม (POST) และไฟล์จากโดเมนอื่น
 * แก้ไฟล์เว็บแล้วให้เปลี่ยนเลข VERSION เพื่อให้ผู้ใช้ได้เวอร์ชันใหม่ */
const VERSION = "esan-smartdna-v3";
const PRECACHE = [
  "./", "index.html", "manifest.webmanifest",
  "assets/logo.png", "assets/icon-192.png", "assets/icon-512.png",
  "assets/coach-yaowapa.webp", "assets/coach-apichat.webp", "assets/coach-anekson.webp",
  "assets/inno-mascot.webp", "assets/inno-septic.webp", "assets/inno-wastebank.webp",
  "assets/inno-atl.webp", "assets/inno-elderly.webp"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // หน้าเว็บ: ลองเครือข่ายก่อน (ได้เนื้อหาล่าสุด) ถ้าออฟไลน์ใช้ที่เก็บไว้
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put("index.html", copy));
        return res;
      }).catch(() => caches.match("index.html"))
    );
    return;
  }

  // รูปและไฟล์อื่น: ใช้ที่เก็บไว้ก่อน แล้วอัปเดตเบื้องหลัง
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
