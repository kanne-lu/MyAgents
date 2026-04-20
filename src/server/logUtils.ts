/**
 * Shared utilities for logging system
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ensureDirSync } from './utils/fs-utils';

export const MYAGENTS_DIR = join(homedir(), '.myagents');
export const LOGS_DIR = join(MYAGENTS_DIR, 'logs');
export const LOG_RETENTION_DAYS = 30;

/**
 * Ensure logs directory exists
 */
export function ensureLogsDir(): void {
  if (!existsSync(MYAGENTS_DIR)) {
    ensureDirSync(MYAGENTS_DIR);
  }
  if (!existsSync(LOGS_DIR)) {
    ensureDirSync(LOGS_DIR);
  }
}
