import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

import { config } from './config.js';
import { getLibraryTrack, resolveLibraryFilePath } from './libraryStore.js';
import { runCommand } from './processUtils.js';
import type { MixPreview, MixProject, MixProjectTimelineItem, MixProjectTrack } from './types.js';

interface MixState {
  projects: Array<{
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    tracks: MixProjectTrack[];
  }>;
}

const mixDir = path.join(config.libraryDir, 'mixes');
const mixStatePath = path.join(mixDir, 'projects.json');
const mixPreviewDir = path.join(mixDir, 'previews');
let cache: MixState | null = null;

function now() {
  return new Date().toISOString();
}

async function ensureMixDir() {
  await Promise.all([mkdir(mixDir, { recursive: true }), mkdir(mixPreviewDir, { recursive: true })]);
}

async function loadState() {
  if (cache) {
    return cache;
  }

  await ensureMixDir();

  try {
    const raw = await readFile(mixStatePath, 'utf8');
    cache = JSON.parse(raw) as MixState;
  } catch {
    cache = { projects: [] };
    await saveState();
  }

  return cache;
}

async function saveState() {
  if (!cache) {
    return;
  }

  await ensureMixDir();
  await writeFile(mixStatePath, JSON.stringify(cache, null, 2));
}

async function materializeProject(project: MixState['projects'][number]): Promise<MixProject> {
  const timeline: MixProjectTimelineItem[] = [];
  let cursor = 0;

  for (let index = 0; index < project.tracks.length; index += 1) {
    const mixTrack = project.tracks[index];
    const libraryTrack = await getLibraryTrack(mixTrack.trackId);
    if (!libraryTrack) {
      continue;
    }

    const durationSeconds = libraryTrack.durationSeconds ?? 0;
    const startSeconds = index === 0 ? 0 : Math.max(0, cursor - mixTrack.overlapSeconds);
    const endSeconds = startSeconds + durationSeconds;

    timeline.push({
      ...mixTrack,
      title: libraryTrack.title,
      filePath: libraryTrack.filePath,
      waveformPath: libraryTrack.waveformPath,
      durationSeconds: libraryTrack.durationSeconds,
      startSeconds,
      endSeconds,
    });

    cursor = endSeconds;
  }

  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    tracks: project.tracks,
    totalDurationSeconds: timeline.length > 0 ? timeline[timeline.length - 1].endSeconds : 0,
    timeline,
  };
}

export async function listMixProjects() {
  const state = await loadState();
  return Promise.all(state.projects.map((project) => materializeProject(project)));
}

export async function createMixProject(name: string) {
  const state = await loadState();
  const project = {
    id: nanoid(10),
    name: name.trim() || 'Untitled mix',
    createdAt: now(),
    updatedAt: now(),
    tracks: [] as MixProjectTrack[],
  };

  state.projects.unshift(project);
  await saveState();
  return materializeProject(project);
}

export async function addTrackToMixProject(projectId: string, trackId: string) {
  const state = await loadState();
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error('Mix project not found');
  }

  const libraryTrack = await getLibraryTrack(trackId);
  if (!libraryTrack) {
    throw new Error('Track not found in library');
  }

  project.tracks.push({
    id: nanoid(10),
    trackId,
    overlapSeconds: Math.min(
      16,
      Math.max(6, Math.round((libraryTrack.suggestedMixInSeconds ?? 8) + 2)),
    ),
  });
  project.updatedAt = now();
  await saveState();
  return materializeProject(project);
}

export async function updateMixTrackOverlap(projectId: string, mixTrackId: string, overlapSeconds: number) {
  const state = await loadState();
  const project = state.projects.find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error('Mix project not found');
  }

  const mixTrack = project.tracks.find((entry) => entry.id === mixTrackId);
  if (!mixTrack) {
    throw new Error('Mix track not found');
  }

  mixTrack.overlapSeconds = Math.max(0, Math.min(30, Math.round(overlapSeconds)));
  project.updatedAt = now();
  await saveState();
  return materializeProject(project);
}

export async function deleteMixProject(projectId: string) {
  const state = await loadState();
  const projectIndex = state.projects.findIndex((entry) => entry.id === projectId);
  if (projectIndex === -1) {
    throw new Error('Mix project not found');
  }

  state.projects.splice(projectIndex, 1);
  await saveState();
}

async function probeDurationSeconds(filePath: string) {
  try {
    const result = await runCommand(config.ffmpegPath, ['-i', filePath, '-f', 'null', '-']);
    const match = result.stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) {
      return undefined;
    }

    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2] ?? 0);
    const seconds = Number(match[3] ?? 0);
    return Math.round(hours * 3600 + minutes * 60 + seconds);
  } catch {
    return undefined;
  }
}

export async function renderMixPreview(projectId: string): Promise<MixPreview> {
  const projects = await listMixProjects();
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error('Mix project not found');
  }

  if (project.timeline.length === 0) {
    throw new Error('Add at least one track to render a preview');
  }

  await ensureMixDir();

  const outputPath = path.join(mixPreviewDir, `${projectId}.mp3`);
  const inputArgs: string[] = [];

  for (const item of project.timeline) {
    inputArgs.push('-i', resolveLibraryFilePath(item.filePath));
  }

  if (project.timeline.length === 1) {
    await runCommand(config.ffmpegPath, [
      '-y',
      ...inputArgs,
      '-vn',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '256k',
      outputPath,
    ]);
  } else {
    const filterParts: string[] = [];
    let previousLabel = '[0:a]';

    for (let index = 1; index < project.timeline.length; index += 1) {
      const outputLabel = index === project.timeline.length - 1 ? '[mixout]' : `[mix${index}]`;
      const overlap = Math.max(1, Math.min(30, Math.round(project.timeline[index].overlapSeconds)));
      filterParts.push(`${previousLabel}[${index}:a]acrossfade=d=${overlap}:c1=tri:c2=tri${outputLabel}`);
      previousLabel = outputLabel;
    }

    await runCommand(config.ffmpegPath, [
      '-y',
      ...inputArgs,
      '-filter_complex',
      filterParts.join(';'),
      '-map',
      previousLabel,
      '-c:a',
      'libmp3lame',
      '-b:a',
      '256k',
      outputPath,
    ]);
  }

  const outputStats = await stat(outputPath);
  const durationSeconds = (await probeDurationSeconds(outputPath)) ?? project.totalDurationSeconds;

  return {
    projectId,
    filePath: `/library/previews/${path.basename(outputPath)}?v=${outputStats.mtimeMs}`,
    renderedAt: now(),
    durationSeconds,
  };
}
