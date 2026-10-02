import { useEffect } from 'react';
import { isTauri } from '../utils/tauri';
import { dailyUpdateCheck } from '../utils/updates';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The quiet once-a-day update check: once at start, then every hour it looks
 * whether a day has passed since the last check (dailyUpdateCheck decides).
 * A found update shows "GreenCLI X is ready." with Restart to update.
 */
export function useUpdateCheck(): void {
  useEffect(() => {
    if (!isTauri) return;
    void dailyUpdateCheck();
    const timer = setInterval(() => void dailyUpdateCheck(), HOUR_MS);
    return () => clearInterval(timer);
  }, []);
}
