import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

import { config } from './config.js';

export async function checkBinaryExists(command: string): Promise<boolean> {
  if (command.includes('/')) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathValue = process.env.PATH ?? '';
  const entries = pathValue.split(':').filter(Boolean);

  for (const entry of entries) {
    try {
      await access(`${entry}/${command}`, constants.X_OK);
      return true;
    } catch {
      // Keep scanning PATH until a matching executable is found.
    }
  }

  return false;
}

export async function getDependencyStatus() {
  const [ffmpegInstalled, ytDlpInstalled] = await Promise.all([
    checkBinaryExists(config.ffmpegPath),
    checkBinaryExists(config.ytDlpPath),
  ]);

  return {
    ffmpegInstalled,
    ytDlpInstalled,
    ready: ffmpegInstalled && ytDlpInstalled,
    ffmpegPath: config.ffmpegPath,
    ytDlpPath: config.ytDlpPath,
  };
}
