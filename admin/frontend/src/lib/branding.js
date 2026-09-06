// Platform branding (name / logo / favicon) — operator-set in Profile →
// Platform branding, served by the PUBLIC GET /api/branding (the login page
// needs it before any session exists).
//
// Loaded once at boot, applied to the document (title + favicon link), and
// readable from any component via useBranding() — a tiny external store, no
// context provider needed. Unset fields are null and every consumer falls
// back to the built-in ProxyPilot branding, so a fresh install looks exactly
// as before.

import { useSyncExternalStore } from 'react';
import { api } from './api';

export const DEFAULT_BRANDING = Object.freeze({ name: 'ProxyPilot', logo: null, favicon: null });
// The custom mark as a real URL (the backend decodes the stored data URI):
// apple-touch-icon and manifest icons need a fetchable file, not inline data.
export const BRANDING_ICON_URL = '/api/branding/icon';

let current = DEFAULT_BRANDING;
const subscribers = new Set();
const subscribe = (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); };
const getSnapshot = () => current;

export function useBranding() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function applyBranding(b = {}) {
  current = {
    name: String(b.name || '').trim() || DEFAULT_BRANDING.name,
    logo: b.logo || null,
    favicon: b.favicon || null,
  };
  // The tab title: the custom platform name plain, or the stock title.
  document.title = current.name === DEFAULT_BRANDING.name ? 'ProxyPilot Admin' : current.name;
  if (current.favicon) {
    // Every <link rel="icon"> (the SVG and the PNG fallback) points at the
    // custom mark, and so does apple-touch-icon: iOS reads that from the DOM
    // when "Add to Home Screen" is tapped, so swapping it here is what puts
    // the custom logo on the phone. The served manifest is branded server-side
    // (GET /manifest.webmanifest) for every other installer.
    const links = document.querySelectorAll('link[rel="icon"]');
    if (links.length === 0) {
      const link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
      link.href = current.favicon;
    } else {
      links.forEach((link) => { link.href = current.favicon; link.removeAttribute('type'); link.removeAttribute('sizes'); });
    }
    // iOS composes the Home Screen tile from a raster only; an SVG/ICO/GIF
    // here yields a blank tile, so those keep the shipped PNG.
    if (/^data:image\/(png|jpeg);/i.test(current.favicon)) {
      let apple = document.querySelector('link[rel="apple-touch-icon"]');
      if (!apple) {
        apple = document.createElement('link');
        apple.rel = 'apple-touch-icon';
        document.head.appendChild(apple);
      }
      apple.href = BRANDING_ICON_URL;
    }
  }
  for (const cb of subscribers) cb();
}

export async function loadBranding() {
  try {
    applyBranding(await api.getBranding());
  } catch {
    // Offline/startup race — the built-in branding stands.
  }
}
