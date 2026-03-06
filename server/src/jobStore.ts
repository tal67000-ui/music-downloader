import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';

import { config } from './config.js';
import { parseYtDlpProgressLine } from './progress.js';
import type { ConversionRequest, JobRecord } from './types.js';
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
    return 'Download blocked by the source site. Try again later or use a proxy/VPN path for outbound requests.';
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

function updateJob(id: string, patch: Partial<JobRecord>) {
  const current = jobs.get(id);
  if (!current) {
    return;
  }

  jobs.set(id, {
    ...current,
    ...patch,
    updatedAt: now(),
  });
}

function updateJobFromProgress(id: string, text: string) {
  for (const line of text.split('\n')) {
    const parsed = parseYtDlpProgressLine(line);
    if (!parsed) {
      continue;
    }

    updateJob(id, {
      progress: parsed.progress,
      stage: parsed.stage,
    });
  }
}

async function probeTitle(url: string): Promise<string | undefined> {
  try {
    const args = ['--no-config-locations', '--print', '%(title)s', '--skip-download', url];
    if (config.mediaProxyUrl) {
      args.unshift(config.mediaProxyUrl);
      args.unshift('--proxy');
    }
    const result = await runCommand(config.ytDlpPath, args);
    const value = result.stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function runConversion(id: string) {
  const job = jobs.get(id);
  if (!job) {
    return;
  }

  const dependencyStatus = await getDependencyStatus();
  if (!dependencyStatus.ready) {
    updateJob(id, {
      status: 'failed',
      stage: 'Missing required binaries',
      progress: 0,
      error: 'Install ffmpeg and yt-dlp, then restart the server.',
    });
    return;
  }

  runningJobs += 1;
  updateJob(id, { status: 'running', stage: 'Inspecting source', progress: 10 });

  try {
    await ensureDirectories();
    const title = (await probeTitle(job.request.url)) ?? 'converted-audio';
    const safeTitle = sanitizeTitle(title);
    const outputBasePath = path.join(config.outputDir, `${id}-${safeTitle}`);
    const outputPath = `${outputBasePath}.${job.request.format}`;
    const bitrate = qualityMap[job.request.quality][job.request.format];

    updateJob(id, {
      title,
      stage: 'Downloading source media',
      progress: 30,
    });

    const commonArgs = [
      '--no-config-locations',
      '--no-call-home',
      '--format',
      'bestaudio/best',
      '--ffmpeg-location',
      config.ffmpegPath,
      '--no-playlist',
      '--output',
      outputBasePath,
    ];

    if (isYoutubeUrl(job.request.url)) {
      commonArgs.push('--extractor-args', 'youtube:player_client=default,-web');
    }

    if (config.mediaProxyUrl) {
      commonArgs.push('--proxy', config.mediaProxyUrl);
    }

    const args =
      job.request.format === 'mp3'
        ? [
            '--extract-audio',
            '--audio-format',
            'mp3',
            '--audio-quality',
            bitrate,
            ...commonArgs,
            job.request.url,
          ]
        : [
            '--extract-audio',
            '--audio-format',
            'm4a',
            '--postprocessor-args',
            `ffmpeg:-b:a ${bitrate}`,
            ...commonArgs,
            job.request.url,
          ];

    await runCommand(config.ytDlpPath, args, {
      env: {
        PYTHONUNBUFFERED: '1',
      },
      onStderr: (text) => {
        updateJobFromProgress(id, text);
      },
    });

    updateJob(id, {
      status: 'completed',
      stage: 'Ready to download',
      progress: 100,
      downloadPath: `/downloads/${path.basename(outputPath)}`,
      downloadName: `${safeTitle}.${job.request.format}`,
    });
  } catch (error) {
    updateJob(id, {
      status: 'failed',
      stage: 'Conversion failed',
      progress: 100,
      error: toPublicErrorMessage(error),
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

    if (job.downloadPath) {
      const filename = path.basename(job.downloadPath);
      await rm(path.join(config.outputDir, filename), { force: true });
    }

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

export function createJob(request: ConversionRequest) {
  const id = nanoid(10);
  const record: JobRecord = {
    id,
    request,
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
    progress: 0,
    stage: 'Queued',
    sourceUrl: request.url,
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
