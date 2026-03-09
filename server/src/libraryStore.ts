import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

import { config } from './config.js';
import type { LibrarySourceType, LibraryTrack } from './types.js';
import { runCommand } from './processUtils.js';

interface LibraryState {
  tracks: LibraryTrack[];
}

const statePath = path.join(config.libraryDir, 'library.json');
const audioDir = path.join(config.libraryDir, 'audio');
const waveformDir = path.join(config.libraryDir, 'waveforms');
let cache: LibraryState | null = null;

function now() {
  return new Date().toISOString();
}

function slugify(value: string) {
  return value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'track';
}

function parseTitleFromFilename(fileName: string) {
  return fileName.replace(path.extname(fileName), '').replace(/[_-]+/g, ' ').trim() || 'Imported track';
}

async function ensureLibraryDirs() {
  await Promise.all([
    mkdir(config.libraryDir, { recursive: true }),
    mkdir(audioDir, { recursive: true }),
    mkdir(waveformDir, { recursive: true }),
  ]);
}

async function loadState() {
  if (cache) {
    return cache;
  }

  await ensureLibraryDirs();

  try {
    const raw = await readFile(statePath, 'utf8');
    cache = JSON.parse(raw) as LibraryState;
  } catch {
    cache = { tracks: [] };
    await saveState();
  }

  return cache;
}

async function saveState() {
  if (!cache) {
    return;
  }

  await ensureLibraryDirs();
  await writeFile(statePath, JSON.stringify(cache, null, 2));
}

function parseDuration(stderr: string) {
  const match = stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) {
    return undefined;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return Math.round(hours * 3600 + minutes * 60 + seconds);
}

function parseMeanVolume(stderr: string) {
  const match = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

async function probeDurationSeconds(filePath: string) {
  return new Promise<number | undefined>((resolve) => {
    const child = spawn(config.ffmpegPath, ['-i', filePath, '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', () => resolve(undefined));
    child.on('close', () => resolve(parseDuration(stderr)));
  });
}

async function probeMeanVolumeDb(filePath: string) {
  return new Promise<number | undefined>((resolve) => {
    const child = spawn(config.ffmpegPath, ['-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', () => resolve(undefined));
    child.on('close', () => resolve(parseMeanVolume(stderr)));
  });
}

async function generateWaveformImage(inputPath: string, id: string) {
  const outputPath = path.join(waveformDir, `${id}.png`);

  try {
    await runCommand(config.ffmpegPath, [
      '-y',
      '-i',
      inputPath,
      '-filter_complex',
      'showwavespic=s=1200x180:colors=0xff6b35',
      '-frames:v',
      '1',
      outputPath,
    ]);
    return `/library/waveforms/${id}.png`;
  } catch {
    return undefined;
  }
}

function getSuggestedMixInSeconds(durationSeconds?: number) {
  if (!durationSeconds || durationSeconds <= 0) {
    return undefined;
  }

  return Math.min(12, Math.max(0, Math.round(durationSeconds * 0.08)));
}

function getSuggestedMixOutSeconds(durationSeconds?: number) {
  if (!durationSeconds || durationSeconds <= 0) {
    return undefined;
  }

  const outroLength = Math.min(24, Math.max(10, Math.round(durationSeconds * 0.14)));
  return Math.max(0, durationSeconds - outroLength);
}

export async function listLibraryTracks() {
  const state = await loadState();
  return state.tracks;
}

export async function getLibraryTrack(trackId: string) {
  const state = await loadState();
  return state.tracks.find((track) => track.id === trackId) ?? null;
}

export function resolveLibraryFilePath(filePath: string) {
  const fileName = path.basename(filePath);
  return path.join(audioDir, fileName);
}

export async function ingestLibraryTrack(input: {
  sourcePath: string;
  originalFileName: string;
  title?: string;
  sourceType: LibrarySourceType;
  sourceUrl?: string;
  format?: string;
  durationSeconds?: number;
  importToken?: string;
  moveSource?: boolean;
}) {
  const state = await loadState();

  if (input.importToken) {
    const existing = state.tracks.find((track) => track.importToken === input.importToken);
    if (existing) {
      return existing;
    }
  }

  const id = nanoid(10);
  const ext = path.extname(input.originalFileName || input.sourcePath) || '.mp3';
  const fileName = `${id}-${slugify(input.originalFileName || input.title || 'track')}${ext}`;
  const destinationPath = path.join(audioDir, fileName);

  await ensureLibraryDirs();

  if (input.moveSource) {
    await rename(input.sourcePath, destinationPath);
  } else {
    await copyFile(input.sourcePath, destinationPath);
  }

  const fileStats = await stat(destinationPath);
  const durationSeconds = input.durationSeconds ?? (await probeDurationSeconds(destinationPath));
  const meanVolumeDb = await probeMeanVolumeDb(destinationPath);
  const waveformPath = await generateWaveformImage(destinationPath, id);

  const track: LibraryTrack = {
    id,
    title: input.title?.trim() || parseTitleFromFilename(input.originalFileName),
    durationSeconds,
    sizeBytes: fileStats.size,
    format: (input.format || ext.replace(/^\./, '') || 'audio').toLowerCase(),
    sourceType: input.sourceType,
    createdAt: now(),
    sourceUrl: input.sourceUrl,
    filePath: `/library/files/${fileName}`,
    waveformPath,
    originalFileName: input.originalFileName,
    importToken: input.importToken,
    meanVolumeDb,
    suggestedMixInSeconds: getSuggestedMixInSeconds(durationSeconds),
    suggestedMixOutSeconds: getSuggestedMixOutSeconds(durationSeconds),
  };

  state.tracks.unshift(track);
  await saveState();
  return track;
}

export async function importExistingOutputs() {
  await ensureLibraryDirs();
  const entries = await readdir(config.outputDir).catch(() => []);
  const imported: LibraryTrack[] = [];

  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (!['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg'].includes(ext)) {
      continue;
    }

    const track = await ingestLibraryTrack({
      sourcePath: path.join(config.outputDir, entry),
      originalFileName: entry,
      title: parseTitleFromFilename(entry),
      sourceType: 'imported',
      format: ext.replace(/^\./, ''),
      importToken: `output:${entry}`,
    });
    imported.push(track);
  }

  return imported;
}

export async function deleteLibraryTracks(trackIds: string[]) {
  const state = await loadState();
  const idSet = new Set(trackIds);
  const tracksToDelete = state.tracks.filter((track) => idSet.has(track.id));

  await Promise.all(
    tracksToDelete.flatMap((track) => {
      const tasks = [rm(resolveLibraryFilePath(track.filePath), { force: true })];

      if (track.waveformPath) {
        tasks.push(rm(path.join(waveformDir, path.basename(track.waveformPath)), { force: true }));
      }

      return tasks;
    }),
  );

  state.tracks = state.tracks.filter((track) => !idSet.has(track.id));
  await saveState();

  return state.tracks;
}
