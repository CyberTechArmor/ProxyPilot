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
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = current.favicon;
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
