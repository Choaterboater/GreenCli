/**
 * Utility functions for Aruba Terminal Pro
 */

export function getDeviceIcon(deviceType: string): string {
  switch (deviceType) {
    case 'aruba-cx':
      return 'CX';
    case 'aruba-ap':
      return 'AP';
    case 'aruba-controller':
      return 'MC';
    default:
      return 'SH';
  }
}

export function getDeviceLabel(deviceType: string): string {
  switch (deviceType) {
    case 'aruba-cx':
      return 'Aruba CX';
    case 'aruba-ap':
      return 'Aruba AP';
    case 'aruba-controller':
      return 'Aruba MC';
    default:
      return 'Generic';
  }
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
