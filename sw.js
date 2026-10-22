"use strict";

const CACHE_PREFIX = "audi-q7-service-book-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const LEGACY_CACHES = new Set(["service-log-shell-v1"]);
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./app-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
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
    event.respondWith(caches.match("./index.html").then((cached) => cached || fetch(request)));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
