"use strict";

const CACHE_PREFIX = "audi-q7-service-book-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v6`;
const LEGACY_CACHES = new Set(["service-log-shell-v1"]);
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./app-icon.png",
  "./app-icon.svg",
  "./app-icon-192.png",
  "./app-icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  const freshRequests = APP_FILES.map((file) => new Request(file, { cache: "reload" }));
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(freshRequests)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME && (key.startsWith(CACHE_PREFIX) || LEGACY_CACHES.has(key))).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(new Request(request, { cache: "no-store" }))
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          }
          return response;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
