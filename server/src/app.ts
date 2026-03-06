import cors from 'cors';
import express, { type Request, type Response } from 'express';
import path from 'node:path';

import { config } from './config.js';
import { createJob, getJob, listJobs } from './jobStore.js';
import { getDependencyStatus } from './mediaTools.js';
import { consumeRateLimit } from './rateLimit.js';
import { createJobSchema } from './validation.js';

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

  const dependencies = await getDependencyStatus();
  if (!dependencies.ready) {
    res.status(503).json({
      error: 'Missing required binaries',
      dependencies,
    });
    return;
  }

  const job = createJob(parsed.data);
  res.status(202).json({ job });
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

  app.get('/api/health', async (_req, res) => {
    const dependencies = await getDependencyStatus();
    res.json({
      ok: true,
      dependencies,
      maxConcurrentJobs: config.maxConcurrentJobs,
    });
  });

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
