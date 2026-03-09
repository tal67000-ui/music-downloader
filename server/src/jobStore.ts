import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

import { config } from './config.js';
import { ingestLibraryTrack } from './libraryStore.js';
import { parseYtDlpProgressLine } from './progress.js';
import type {
  BatchConversionRequest,
  BatchItemRecord,
  CreateJobRequest,
  JobRecord,
  OutputFormat,
  QualityPreset,
  SourceEntry,
  SourceInspection,
} from './types.js';
import { getDependencyStatus } from './mediaTools.js';
import { runCommand } from './processUtils.js';

const jobs = new Map<string, JobRecord>();
const queue: string[] = [];
let runningJobs = 0;

const qualityMap = {
  standard: { mp3: '192k', m4a: '160k' },
  high: { mp3: '320k', m4a: '256k' },
} as const;

async function ensureDirectories() {
  await Promise.all([
    mkdir(config.outputDir, { recursive: true }),
    mkdir(config.tempDir, { recursive: true }),
  ]);
}

function now() {
  return new Date().toISOString();
}

function sanitizeTitle(value: string) {
  return value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'audio';
}

function toPublicErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown conversion error';
  const sanitized = message
    .replaceAll(config.rootDir, '[workspace]')
    .replaceAll(process.env.HOME ?? '', '~');

  if (/403|forbidden/i.test(sanitized)) {
    return 'Download blocked by the source site. Try again later or use a proxy or VPN path for outbound requests.';
  }

  if (/cookies|sign in|login|age-restricted|members-only/i.test(sanitized)) {
    return 'This source requires authentication or access the app is not configured to provide.';
  }

  if (/private|unavailable|not available|video is unavailable/i.test(sanitized)) {
    return 'This media is unavailable or restricted at the source.';
  }

  if (/unsupported url|unsupported/i.test(sanitized)) {
    return 'This link is not supported by the current downloader configuration.';
  }

  if (/timeout|timed out|network is unreachable|connection refused|proxy/i.test(sanitized)) {
    return 'Network access failed while retrieving the source media.';
  }

  return 'Conversion failed. The source may be blocking automated access or require a different outbound network path.';
}

function isYoutubeUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname === 'm.youtube.com' ||
      hostname === 'youtu.be' ||
      hostname.endsWith('.youtube.com')
    );
  } catch {
    return false;
  }
}

function buildYtDlpArgs(baseUrl: string) {
  const args = ['--no-config-locations', '--no-call-home'];

  if (isYoutubeUrl(baseUrl)) {
    args.push('--extractor-args', 'youtube:player_client=default,-web');
  }

  if (config.mediaProxyUrl) {
    args.push('--proxy', config.mediaProxyUrl);
  }

  return args;
}

function getEstimatedTotalSeconds(entries: Array<{ durationSeconds?: number }>) {
  const total = entries.reduce((sum, entry) => sum + (entry.durationSeconds ?? 0), 0);
  return total > 0 ? total : undefined;
}

function deriveEntryUrl(raw: Record<string, unknown>, sourceUrl: string) {
  const webpageUrl = typeof raw.webpage_url === 'string' ? raw.webpage_url : undefined;
  if (webpageUrl) {
    return webpageUrl;
  }

  const rawUrl = typeof raw.url === 'string' ? raw.url : undefined;
  if (rawUrl?.startsWith('http://') || rawUrl?.startsWith('https://')) {
    return rawUrl;
  }

  const id = typeof raw.id === 'string' ? raw.id : undefined;
  if (id && isYoutubeUrl(sourceUrl)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }

  return rawUrl;
}

function toSourceEntry(raw: Record<string, unknown>, sourceUrl: string, index: number): SourceEntry | null {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : `entry-${index}`;
  const url = deriveEntryUrl(raw, sourceUrl);
  const durationValue = typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? raw.duration : undefined;

  if (!url) {
    return null;
  }

  return {
    id,
    url,
    title: title || `Item ${index}`,
    index,
    durationSeconds: durationValue,
  };
}

function normalizeCreateJobRequest(request: CreateJobRequest): BatchConversionRequest {
  if ('items' in request) {
    return request;
  }

  return {
    sourceUrl: request.url,
    format: request.format,
    quality: request.quality,
    items: [
      {
        id: nanoid(8),
        url: request.url,
        title: 'Selected media',
        index: 1,
      },
    ],
  };
}

function recalculateJob(job: JobRecord, patch: Partial<JobRecord> = {}): JobRecord {
  const next = {
    ...job,
    ...patch,
  };

  const completedCount = next.items.filter((item) => item.status === 'completed').length;
  const failedCount = next.items.filter((item) => item.status === 'failed').length;
  const totalCount = Math.max(next.items.length, 1);
  const progress = Math.round(next.items.reduce((sum, item) => sum + item.progress, 0) / totalCount);

  const estimatedRemainingSeconds =
    next.estimatedTotalSeconds === undefined
      ? undefined
      : Math.max(
          0,
          Math.round(
            next.items.reduce((sum, item) => {
              if (!item.durationSeconds) {
                return sum;
              }

              if (item.status === 'completed' || item.status === 'failed') {
                return sum;
              }

              const multiplier = item.status === 'running' ? (100 - item.progress) / 100 : 1;
              return sum + item.durationSeconds * multiplier;
            }, 0),
          ),
        );

  return {
    ...next,
    completedCount,
    failedCount,
    progress,
    estimatedRemainingSeconds,
    updatedAt: now(),
  };
}

function updateJob(jobId: string, patch: Partial<JobRecord> = {}) {
  const current = jobs.get(jobId);
  if (!current) {
    return;
  }

  jobs.set(jobId, recalculateJob(current, patch));
}

function updateItem(
  jobId: string,
  itemId: string,
  patch: Partial<BatchItemRecord>,
  topLevelPatch: Partial<JobRecord> = {},
) {
  const current = jobs.get(jobId);
  if (!current) {
    return;
  }

  const items = current.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
  jobs.set(jobId, recalculateJob(current, { ...topLevelPatch, items }));
}

async function probeTitle(url: string): Promise<string | undefined> {
  try {
    const result = await runCommand(config.ytDlpPath, [...buildYtDlpArgs(url), '--print', '%(title)s', '--skip-download', url]);
    const value = result.stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function inspectSource(url: string): Promise<SourceInspection> {
  const args = [
    ...buildYtDlpArgs(url),
    '--flat-playlist',
    '--dump-single-json',
    '--playlist-end',
    '200',
    url,
  ];

  const result = await runCommand(config.ytDlpPath, args);
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];

  const entries =
    rawEntries.length > 0
      ? rawEntries
          .map((entry, index) => (entry && typeof entry === 'object' ? toSourceEntry(entry as Record<string, unknown>, url, index + 1) : null))
          .filter((entry): entry is SourceEntry => entry !== null)
      : (() => {
          const single = toSourceEntry(parsed, url, 1);
          return single ? [single] : [];
        })();

  if (entries.length === 0) {
    throw new Error('No playable items were found in this source.');
  }

  return {
    sourceUrl: url,
    title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : entries[0].title,
    kind: entries.length > 1 ? 'list' : 'single',
    entryCount: entries.length,
    entries,
    estimatedTotalSeconds: getEstimatedTotalSeconds(entries),
  };
}

export async function resolveRecommendationSource(query: string): Promise<SourceEntry> {
  const result = await runCommand(config.ytDlpPath, [
    ...buildYtDlpArgs('https://www.youtube.com'),
    '--dump-single-json',
    '--no-playlist',
    `ytsearch1:${query}`,
  ]);

  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const entry = toSourceEntry(parsed, 'https://www.youtube.com', 1);

  if (!entry) {
    throw new Error('No downloadable source could be resolved for this recommendation.');
  }

  return entry;
}

function buildTopLevelStage(itemTitle: string, index: number, total: number, stage: string) {
  return `Item ${index}/${total}: ${itemTitle} - ${stage}`;
}

async function runSingleItem(
  jobId: string,
  item: BatchItemRecord,
  position: number,
  total: number,
  format: OutputFormat,
  quality: QualityPreset,
) {
  const title = item.title || (await probeTitle(item.url)) || 'converted-audio';
  const safeTitle = sanitizeTitle(title);
  const outputBasePath = path.join(config.outputDir, `${jobId}-${item.index}-${safeTitle}`);
  const outputPath = `${outputBasePath}.${format}`;
  const bitrate = qualityMap[quality][format];

  updateItem(
    jobId,
    item.id,
    {
      status: 'running',
      progress: 10,
      stage: 'Inspecting source',
      title,
    },
    {
      status: 'running',
      currentItemId: item.id,
      stage: buildTopLevelStage(title, position, total, 'Inspecting source'),
    },
  );

  const commonArgs = [
    ...buildYtDlpArgs(item.url),
    '--format',
    'bestaudio/best',
    '--ffmpeg-location',
    config.ffmpegPath,
    '--no-playlist',
    '--output',
    outputBasePath,
  ];

  const args =
    format === 'mp3'
      ? ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', bitrate, ...commonArgs, item.url]
      : [
          '--extract-audio',
          '--audio-format',
          'm4a',
          '--postprocessor-args',
          `ffmpeg:-b:a ${bitrate}`,
          ...commonArgs,
          item.url,
        ];

  await runCommand(config.ytDlpPath, args, {
    env: {
      PYTHONUNBUFFERED: '1',
    },
    onStderr: (text) => {
      for (const line of text.split('\n')) {
        const parsed = parseYtDlpProgressLine(line);
        if (!parsed) {
          continue;
        }

        updateItem(
          jobId,
          item.id,
          {
            progress: parsed.progress ?? item.progress,
            stage: parsed.stage ?? item.stage,
          },
          {
            status: 'running',
            currentItemId: item.id,
            stage: buildTopLevelStage(title, position, total, parsed.stage ?? 'Working'),
          },
        );
      }
    },
  });

  await ingestLibraryTrack({
    sourcePath: outputPath,
    originalFileName: `${safeTitle}.${format}`,
    title,
    sourceType: 'downloaded',
    sourceUrl: item.url,
    format,
    durationSeconds: item.durationSeconds,
    importToken: `download:${jobId}:${item.id}`,
  });

  updateItem(
    jobId,
    item.id,
    {
      status: 'completed',
      progress: 100,
      stage: 'Ready to download',
      downloadPath: `/downloads/${path.basename(outputPath)}`,
      downloadName: `${safeTitle}.${format}`,
    },
    {
      status: 'running',
      currentItemId: item.id,
      stage: buildTopLevelStage(title, position, total, 'Completed'),
    },
  );
}

async function runConversion(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  const dependencyStatus = await getDependencyStatus();
  if (!dependencyStatus.ready) {
    updateJob(jobId, {
      status: 'failed',
      stage: 'Missing required binaries',
      progress: 0,
      error: 'Install ffmpeg and yt-dlp, then restart the server.',
    });
    return;
  }

  runningJobs += 1;
  updateJob(jobId, {
    status: 'running',
    stage: `Queued batch started (${job.itemCount} item${job.itemCount === 1 ? '' : 's'})`,
  });

  try {
    await ensureDirectories();
    const itemsSnapshot = jobs.get(jobId)?.items ?? [];

    for (let index = 0; index < itemsSnapshot.length; index += 1) {
      const item = jobs.get(jobId)?.items[index];
      if (!item) {
        continue;
      }

      try {
        await runSingleItem(jobId, item, index + 1, itemsSnapshot.length, job.format, job.quality);
      } catch (error) {
        updateItem(
          jobId,
          item.id,
          {
            status: 'failed',
            progress: 100,
            stage: 'Conversion failed',
            error: toPublicErrorMessage(error),
          },
          {
            status: 'running',
            currentItemId: item.id,
            stage: buildTopLevelStage(item.title, index + 1, itemsSnapshot.length, 'Failed'),
          },
        );
      }
    }

    const final = jobs.get(jobId);
    if (!final) {
      return;
    }

    const status = final.completedCount > 0 ? 'completed' : 'failed';
    const stage =
      final.failedCount > 0
        ? `Finished with ${final.failedCount} failure${final.failedCount === 1 ? '' : 's'}`
        : 'Ready to download';

    updateJob(jobId, {
      status,
      stage,
      currentItemId: undefined,
      error: final.completedCount > 0 ? undefined : 'No selected items completed successfully.',
    });
  } finally {
    runningJobs -= 1;
    void drainQueue();
  }
}

async function drainQueue() {
  if (runningJobs >= config.maxConcurrentJobs) {
    return;
  }

  const nextId = queue[0];
  if (!nextId) {
    return;
  }

  const job = jobs.get(nextId);
  if (!job || job.status !== 'queued') {
    queue.shift();
    void drainQueue();
    return;
  }

  queue.shift();
  void runConversion(nextId);
}

async function cleanupExpiredJobs() {
  const cutoff = Date.now() - config.jobRetentionMs;

  for (const [id, job] of jobs.entries()) {
    const updatedAt = new Date(job.updatedAt).getTime();
    if (updatedAt > cutoff) {
      continue;
    }

    await Promise.all(
      job.items
        .filter((item) => item.downloadPath)
        .map((item) => rm(path.join(config.outputDir, path.basename(item.downloadPath!)), { force: true })),
    );

    jobs.delete(id);
  }

  try {
    const tempEntries = await readdir(config.tempDir);
    await Promise.all(
      tempEntries.map((entry) => rm(path.join(config.tempDir, entry), { recursive: true, force: true })),
    );
  } catch {
    // Temp cleanup should not crash the app.
  }
}

const cleanupTimer = setInterval(() => {
  void cleanupExpiredJobs();
}, 5 * 60 * 1000);

cleanupTimer.unref();

export function createJob(request: CreateJobRequest) {
  const normalized = normalizeCreateJobRequest(request);
  const id = nanoid(10);
  const items: BatchItemRecord[] = normalized.items.map((item, index) => ({
    ...item,
    index: item.index || index + 1,
    status: 'queued',
    progress: 0,
    stage: 'Queued',
  }));
  const estimatedTotalSeconds = getEstimatedTotalSeconds(items);
  const record: JobRecord = {
    id,
    mode: items.length > 1 ? 'batch' : 'single',
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
    progress: 0,
    stage: 'Queued',
    sourceUrl: normalized.sourceUrl,
    format: normalized.format,
    quality: normalized.quality,
    itemCount: items.length,
    completedCount: 0,
    failedCount: 0,
    title: items.length > 1 ? `${items.length} selected tracks` : items[0]?.title,
    items,
    estimatedTotalSeconds,
    estimatedRemainingSeconds: estimatedTotalSeconds,
  };

  jobs.set(id, record);
  queue.push(id);
  void drainQueue();
  return record;
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function listJobs() {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
