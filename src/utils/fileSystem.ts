import { invoke } from '@tauri-apps/api/tauri';
import { open as openDialog, save as saveDialog } from '@tauri-apps/api/dialog';

export const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export async function tauriOpen(): Promise<string | null> {
  const result = await openDialog({
    title: 'Open File',
    filters: [{ name: 'All Files', extensions: ['*'] }],
    multiple: false,
  });
  return typeof result === 'string' ? result : null;
}

export async function tauriSave(defaultName: string): Promise<string | null> {
  const result = await saveDialog({
    title: 'Save File',
    defaultPath: defaultName,
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });
  return result ?? null;
}

export async function tauriReadText(path: string): Promise<string> {
  return invoke<string>('read_file_text', { path });
}

export async function tauriWriteText(path: string, data: string): Promise<void> {
  await invoke('write_file_text', { path, contents: data });
}

export function browserOpen(): Promise<{ name: string; content: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = (e) => resolve({ name: file.name, content: e.target?.result as string ?? '' });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function browserSave(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}