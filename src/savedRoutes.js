// Local-only persistence for "My Routes" — no backend. Pure, framework-free,
// mirrors the engine's separation-of-concerns style.

const KEY = 'routeart.savedRoutes.v1'; // versioned so future schema changes can migrate/ignore safely
const CAP = 20;

export function loadSavedRoutes() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return []; // corrupted JSON or storage denial (private browsing) must not crash the app
  }
}

export function saveRoute(existing, record) {
  const next = [record, ...existing].slice(0, CAP); // newest first, evict oldest beyond CAP
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* quota exceeded — keep in-memory only */ }
  return next;
}

export function deleteRoute(existing, id) {
  const next = existing.filter((r) => r.id !== id);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
  return next;
}

export function newRouteId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
