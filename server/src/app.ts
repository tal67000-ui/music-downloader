import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';

import { config } from './config.js';
import { createJob, getJob, inspectSource, listJobs, resolveRecommendationSource } from './jobStore.js';
import { deleteLibraryTracks, importExistingOutputs, ingestLibraryTrack, listLibraryTracks } from './libraryStore.js';
import { getDependencyStatus } from './mediaTools.js';
import { addTrackToMixProject, createMixProject, deleteMixProject, listMixProjects, renderMixPreview, updateMixTrackOverlap } from './mixStore.js';
import { getRecommendations } from './recommendations.js';
import { consumeRateLimit } from './rateLimit.js';
import { createJobSchema, inspectSourceSchema, recommendationSchema, resolveRecommendationSchema } from './validation.js';

mkdirSync(config.tempDir, { recursive: true });

const upload = multer({
  dest: config.tempDir,
  limits: {
    files: 20,
    fileSize: 500 * 1024 * 1024,
  },
});

async function ensureDependencies(res: Response) {
  const dependencies = await getDependencyStatus();
  if (!dependencies.ready) {
    res.status(503).json({
      error: 'Missing required binaries',
      dependencies,
    });
    return null;
  }

  return dependencies;
}

export async function handleInspectSource(req: Request, res: Response) {
  const parsed = inspectSourceSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      details: parsed.error.flatten(),
    });
    return;
  }

  const dependencies = await ensureDependencies(res);
  if (!dependencies) {
    return;
  }

  try {
    const source = await inspectSource(parsed.data.url);
    res.json({ source });
  } catch (error) {
    res.status(422).json({
      error: error instanceof Error ? error.message : 'Unable to inspect source',
    });
  }
}

export async function handleCreateJob(req: Request, res: Response) {
  const limit = consumeRateLimit(req.ip);
  res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
  res.setHeader('X-RateLimit-Reset', String(limit.resetAt));

  if (!limit.allowed) {
    res.status(429).json({
      error: 'Too many conversion requests. Please wait a minute and try again.',
    });
    return;
  }

  const parsed = createJobSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      details: parsed.error.flatten(),
    });
    return;
  }

  const dependencies = await ensureDependencies(res);
  if (!dependencies) {
    return;
  }

  const job = createJob(parsed.data);
  res.status(202).json({ job });
}

export async function handleRecommendations(req: Request, res: Response) {
  const parsed = recommendationSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      details: parsed.error.flatten(),
    });
    return;
  }

  try {
    const recommendations = await getRecommendations(parsed.data);
    res.json(recommendations);
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Unable to fetch recommendations',
    });
  }
}

export async function handleResolveRecommendation(req: Request, res: Response) {
  const parsed = resolveRecommendationSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request',
      details: parsed.error.flatten(),
    });
    return;
  }

  const dependencies = await ensureDependencies(res);
  if (!dependencies) {
    return;
  }

  try {
    const source = await resolveRecommendationSource(parsed.data.query);
    res.json({ source });
  } catch (error) {
    res.status(422).json({
      error: error instanceof Error ? error.message : 'Unable to resolve recommendation source',
    });
  }
}

export async function handleListLibrary(_req: Request, res: Response) {
  const tracks = await listLibraryTracks();
  res.json({ tracks });
}

export async function handleImportLibraryOutputs(_req: Request, res: Response) {
  const tracks = await importExistingOutputs();
  res.json({ tracks });
}

export async function handleUploadLibrary(req: Request, res: Response) {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];

  if (files.length === 0) {
    res.status(400).json({ error: 'No files uploaded' });
    return;
  }

  try {
    const tracks = await Promise.all(
      files.map((file) =>
        ingestLibraryTrack({
          sourcePath: file.path,
          originalFileName: file.originalname,
          title: file.originalname.replace(path.extname(file.originalname), ''),
          sourceType: 'uploaded',
          format: path.extname(file.originalname).replace(/^\./, ''),
          importToken: `upload:${file.originalname}:${file.size}`,
          moveSource: true,
        }),
      ),
    );

    res.status(201).json({ tracks });
  } catch (error) {
    res.status(422).json({
      error: error instanceof Error ? error.message : 'Unable to upload tracks',
    });
  }
}

export async function handleDeleteLibrary(req: Request, res: Response) {
  const trackIds = Array.isArray(req.body?.trackIds)
    ? req.body.trackIds.filter((value: unknown): value is string => typeof value === 'string')
    : [];

  if (trackIds.length === 0) {
    res.status(400).json({ error: 'trackIds are required' });
    return;
  }

  const tracks = await deleteLibraryTracks(trackIds);
  res.json({ tracks });
}

export async function handleListMixProjects(_req: Request, res: Response) {
  const projects = await listMixProjects();
  res.json({ projects });
}

export async function handleCreateMixProject(req: Request, res: Response) {
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const project = await createMixProject(name);
  res.status(201).json({ project });
}

export async function handleAddTrackToMixProject(req: Request, res: Response) {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const trackId = typeof req.body?.trackId === 'string' ? req.body.trackId : '';
  if (!projectId || !trackId) {
    res.status(400).json({ error: 'trackId is required' });
    return;
  }

  try {
    const project = await addTrackToMixProject(projectId, trackId);
    res.json({ project });
  } catch (error) {
    res.status(404).json({
      error: error instanceof Error ? error.message : 'Unable to update mix project',
    });
  }
}

export async function handleUpdateMixTrack(req: Request, res: Response) {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const mixTrackId = Array.isArray(req.params.trackId) ? req.params.trackId[0] : req.params.trackId;
  const overlapSeconds = typeof req.body?.overlapSeconds === 'number' ? req.body.overlapSeconds : Number.NaN;

  if (!projectId || !mixTrackId || !Number.isFinite(overlapSeconds)) {
    res.status(400).json({ error: 'overlapSeconds is required' });
    return;
  }

  try {
    const project = await updateMixTrackOverlap(projectId, mixTrackId, overlapSeconds);
    res.json({ project });
  } catch (error) {
    res.status(404).json({
      error: error instanceof Error ? error.message : 'Unable to update mix track',
    });
  }
}

export async function handleDeleteMixProject(req: Request, res: Response) {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!projectId) {
    res.status(400).json({ error: 'project id is required' });
    return;
  }

  try {
    await deleteMixProject(projectId);
    res.status(204).end();
  } catch (error) {
    res.status(404).json({
      error: error instanceof Error ? error.message : 'Unable to delete mix project',
    });
  }
}

export async function handleRenderMixPreview(req: Request, res: Response) {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!projectId) {
    res.status(400).json({ error: 'project id is required' });
    return;
  }

  const dependencies = await ensureDependencies(res);
  if (!dependencies) {
    return;
  }

  try {
    const preview = await renderMixPreview(projectId);
    res.json({ preview });
  } catch (error) {
    res.status(422).json({
      error: error instanceof Error ? error.message : 'Unable to render preview',
    });
  }
}

export function createApp() {
  const clientDistDir = path.resolve(config.rootDir, 'client', 'dist');
  const app = express();
  app.set('trust proxy', config.trustProxy);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use(
    cors({
      origin: config.clientOrigin,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use('/downloads', express.static(config.outputDir));
  app.use('/library/files', express.static(path.join(config.libraryDir, 'audio')));
  app.use('/library/waveforms', express.static(path.join(config.libraryDir, 'waveforms')));
  app.use('/library/previews', express.static(path.join(config.libraryDir, 'mixes', 'previews')));

  app.get('/api/health', async (_req, res) => {
    const dependencies = await getDependencyStatus();
    res.json({
      ok: true,
      dependencies,
      maxConcurrentJobs: config.maxConcurrentJobs,
    });
  });

  app.post('/api/sources/inspect', handleInspectSource);
  app.get('/api/library', handleListLibrary);
  app.post('/api/library/import-existing', handleImportLibraryOutputs);
  app.post('/api/library/upload', upload.array('tracks', 20), handleUploadLibrary);
  app.delete('/api/library', handleDeleteLibrary);
  app.get('/api/mixes', handleListMixProjects);
  app.post('/api/mixes', handleCreateMixProject);
  app.delete('/api/mixes/:id', handleDeleteMixProject);
  app.post('/api/mixes/:id/tracks', handleAddTrackToMixProject);
  app.patch('/api/mixes/:id/tracks/:trackId', handleUpdateMixTrack);
  app.post('/api/mixes/:id/preview', handleRenderMixPreview);
  app.post('/api/recommendations', handleRecommendations);
  app.post('/api/recommendations/resolve', handleResolveRecommendation);
  app.get('/api/jobs', (_req, res) => {
    res.json({ jobs: listJobs() });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.json({ job });
  });

  app.post('/api/jobs', handleCreateJob);

  app.use(express.static(clientDistDir));

  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDistDir, 'index.html'));
  });

  return app;
}
