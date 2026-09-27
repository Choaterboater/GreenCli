// ~/.ssh/config scan for the Import hosts dialog (its "~/.ssh/config" tab).
// Saving goes through the dialog's shared preview, like every other source.

import { invoke } from '@tauri-apps/api/tauri';

export interface ImportedHost {
  name: string;
  host: string;
  port: number;
  username?: string;
  identityFile?: string;
  jumpHost?: string;
}

export function scanSshConfig(): Promise<ImportedHost[]> {
  return invoke<ImportedHost[]>('import_ssh_config');
}
