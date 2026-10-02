// Folder view in the Config Editor: the rows of the file tree, from the flat
// listing the backend gives (list_folder: folders first, depth-first). Pure,
// so it is unit-tested.

export interface FolderEntry {
  /** From the folder, `/` between parts on every system. */
  path: string;
  isDir: boolean;
  size: number;
}

export interface FolderListing {
  root: string;
  entries: FolderEntry[];
  /** The backend stopped listing (too many files, or too deep). */
  truncated: boolean;
}

export interface TreeRow extends FolderEntry {
  name: string;
  depth: number;
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let p = parentOf(path); p; p = parentOf(p)) out.push(p);
  return out;
}

/**
 * The rows to show. Without a filter: the children of open folders. With one:
 * every file whose path has it (any case), with the folders on its way, all open.
 */
export function visibleRows(entries: readonly FolderEntry[], open: ReadonlySet<string>, filter = ''): TreeRow[] {
  const q = filter.trim().toLowerCase();
  const row = (e: FolderEntry): TreeRow => ({ ...e, name: e.path.slice(e.path.lastIndexOf('/') + 1), depth: e.path.split('/').length - 1 });
  if (!q) return entries.filter((e) => ancestors(e.path).every((a) => open.has(a))).map(row);
  const keep = new Set<string>();
  for (const e of entries) {
    if (!e.isDir && e.path.toLowerCase().includes(q)) {
      keep.add(e.path);
      ancestors(e.path).forEach((a) => keep.add(a));
    }
  }
  return entries.filter((e) => keep.has(e.path)).map(row);
}

/** The full path of an entry, with the root's own separator (Windows `\`). */
export function joinPath(root: string, rel: string): string {
  const windows = root.includes('\\') && !root.includes('/');
  const sep = windows ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + (windows ? rel.replace(/\//g, '\\') : rel);
}

export const MAX_OPEN_BYTES = 5 * 1024 * 1024;
const BINARY = /\.(?:png|jpe?g|gif|bmp|ico|icns|webp|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|pkg|exe|dll|so|dylib|bin|img|iso|msi|deb|rpm|class|jar|pyc|o|a|woff2?|ttf|otf|mp[34]|mov|avi|wav|db|sqlite)$/i;

/** Why a file won't open in the editor, or null when it can. */
export function cannotOpen(entry: FolderEntry): string | null {
  if (entry.isDir) return null;
  if (BINARY.test(entry.path)) return 'Not a text file';
  if (entry.size > MAX_OPEN_BYTES) return 'Too big for the editor (over 5 MB)';
  return null;
}

/** A full path as a path from the folder (`/` between parts), or null when it is outside. */
export function relativeTo(root: string, path: string | null): string | null {
  if (!path) return null;
  const base = root.replace(/[\\/]+$/, '');
  if (!(path.startsWith(`${base}/`) || path.startsWith(`${base}\\`))) return null;
  return path.slice(base.length + 1).replace(/\\/g, '/');
}
