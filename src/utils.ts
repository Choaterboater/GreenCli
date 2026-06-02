/**
 * Utility functions for HPE Network Terminal
 */

import { deviceMeta } from './types';

export function getDeviceIcon(deviceType: string): string {
  return deviceMeta(deviceType).short;
}

export function getDeviceLabel(deviceType: string): string {
  return deviceMeta(deviceType).label;
}

export function getProtocolLabel(protocol: string): string {
  switch (protocol) {
    case 'ssh':
      return 'SSH';
    case 'telnet':
      return 'Telnet';
    case 'serial':
      return 'Serial';
    default:
      return protocol.toUpperCase();
  }
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  ms: number
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function clamp(num: number, min: number, max: number): number {
  return Math.min(Math.max(num, min), max);
}

// Fuzzy match inspired by cencli's device lookup: case-insensitive, ignoring
// hyphens/underscores/spaces, substring-preferred with a subsequence fallback.
// Returns a score (higher = better) or -1 for no match.
export function fuzzyScore(query: string, target: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, '');
  const q = norm(query);
  const t = norm(target);
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx - (t.length - q.length); // contiguous match wins
  // Subsequence: every query char appears in order; reward adjacency.
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += streak;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

export function fuzzyMatch(query: string, target: string): boolean {
  return !query.trim() || fuzzyScore(query, target) >= 0;
}
