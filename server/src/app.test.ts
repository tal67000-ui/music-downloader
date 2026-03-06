import { afterEach, describe, expect, it, vi } from 'vitest';
import httpMocks from 'node-mocks-http';
import type { Request, Response } from 'express';

import { handleCreateJob, handleInspectSource, handleRecommendations, handleResolveRecommendation } from './app.js';
import { resetRateLimits } from './rateLimit.js';

vi.mock('./mediaTools.js', () => ({
  getDependencyStatus: vi.fn(async () => ({
    ffmpegInstalled: true,
    ytDlpInstalled: true,
    ready: true,
    ffmpegPath: '/tmp/ffmpeg',
    ytDlpPath: '/tmp/yt-dlp',
  })),
}));

vi.mock('./jobStore.js', () => ({
  inspectSource: vi.fn(async (url: string) => ({
    sourceUrl: url,
    title: 'Example source',
    kind: 'list',
    entryCount: 2,
    estimatedTotalSeconds: 360,
    entries: [
      {
        id: 'one',
        url: 'https://example.com/one',
        title: 'Track one',
        index: 1,
        durationSeconds: 120,
      },
      {
        id: 'two',
        url: 'https://example.com/two',
        title: 'Track two',
        index: 2,
        durationSeconds: 240,
      },
    ],
  })),
  createJob: vi.fn((requestBody) => ({
    id: 'job-123',
    mode: 'batch',
    status: 'queued',
    createdAt: '2026-03-06T00:00:00.000Z',
    updatedAt: '2026-03-06T00:00:00.000Z',
    progress: 0,
    stage: 'Queued',
    sourceUrl: 'sourceUrl' in requestBody ? requestBody.sourceUrl : requestBody.url,
    format: requestBody.format,
    quality: requestBody.quality,
    itemCount: 'items' in requestBody ? requestBody.items.length : 1,
    completedCount: 0,
    failedCount: 0,
    items:
      'items' in requestBody
        ? requestBody.items.map((item: { id: string; url: string; title: string; index: number }) => ({
            ...item,
            status: 'queued',
            progress: 0,
            stage: 'Queued',
          }))
        : [],
  })),
  getJob: vi.fn(() => undefined),
  listJobs: vi.fn(() => []),
  resolveRecommendationSource: vi.fn(async (query: string) => ({
    id: 'resolved-one',
    url: 'https://www.youtube.com/watch?v=resolved',
    title: `Resolved ${query}`,
    index: 1,
    durationSeconds: 210,
  })),
}));

vi.mock('./recommendations.js', () => ({
  getRecommendations: vi.fn(async (input: { title: string; artist?: string }) => ({
    seed: {
      title: input.title,
      artist: input.artist,
    },
    recommendations: [
      {
        id: 'rec-1',
        title: 'Similar track',
        artist: 'Similar artist',
        score: 0.91,
        reason: 'Similar track',
        source: 'lastfm-track',
        sourceQuery: 'Similar artist - Similar track',
        sourceUrl: 'https://www.youtube.com/results?search_query=Similar+artist+-+Similar+track',
        sourceLabel: 'YouTube search',
      },
    ],
    providerStatus: {
      musicBrainz: 'used',
      lastfm: 'used',
    },
  })),
}));

describe('app handlers', () => {
  afterEach(() => {
    resetRateLimits();
  });

  async function sendCreateJob(payload: unknown, ip: string) {
    const req = httpMocks.createRequest<Request>({
      method: 'POST',
      url: '/api/jobs',
      ip,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: payload as Record<string, unknown>,
    });
    const res = httpMocks.createResponse<Response>();
    await handleCreateJob(req, res);

    return res;
  }

  async function sendInspect(payload: unknown) {
    const req = httpMocks.createRequest<Request>({
      method: 'POST',
      url: '/api/sources/inspect',
      headers: {
        'content-type': 'application/json',
      },
      body: payload as Record<string, unknown>,
    });
    const res = httpMocks.createResponse<Response>();
    await handleInspectSource(req, res);

    return res;
  }

  async function sendRecommendations(payload: unknown) {
    const req = httpMocks.createRequest<Request>({
      method: 'POST',
      url: '/api/recommendations',
      headers: {
        'content-type': 'application/json',
      },
      body: payload as Record<string, unknown>,
    });
    const res = httpMocks.createResponse<Response>();
    await handleRecommendations(req, res);

    return res;
  }

  async function sendRecommendationResolve(payload: unknown) {
    const req = httpMocks.createRequest<Request>({
      method: 'POST',
      url: '/api/recommendations/resolve',
      headers: {
        'content-type': 'application/json',
      },
      body: payload as Record<string, unknown>,
    });
    const res = httpMocks.createResponse<Response>();
    await handleResolveRecommendation(req, res);

    return res;
  }

  it('inspects a list source', async () => {
    const response = await sendInspect({
      url: 'https://www.youtube.com/@Revealedrec/videos',
    });

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().source.entryCount).toBe(2);
  });

  it('accepts a batch conversion request', async () => {
    const response = await sendCreateJob(
      {
        sourceUrl: 'https://www.youtube.com/@Revealedrec/videos',
        format: 'mp3',
        quality: 'high',
        items: [
          {
            id: 'one',
            url: 'https://example.com/one',
            title: 'Track one',
            index: 1,
            durationSeconds: 120,
          },
        ],
      },
      '203.0.113.10',
    );

    expect(response.statusCode).toBe(202);
    expect(response._getJSONData().job.id).toBe('job-123');
    expect(response.getHeader('X-RateLimit-Remaining')).toBe('4');
  });

  it('returns recommendations for a completed track', async () => {
    const response = await sendRecommendations({
      title: 'Kura & DJ TORA - Pounding Kick',
    });

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().recommendations).toHaveLength(1);
  });

  it('resolves a recommendation to a downloadable source', async () => {
    const response = await sendRecommendationResolve({
      query: 'Similar artist - Similar track',
    });

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().source.url).toContain('youtube.com/watch');
  });

  it('rejects private network URLs', async () => {
    const response = await sendCreateJob(
      {
        sourceUrl: 'https://www.youtube.com/@Revealedrec/videos',
        format: 'mp3',
        quality: 'high',
        items: [
          {
            id: 'one',
            url: 'http://127.0.0.1:8080/song.mp3',
            title: 'Track one',
            index: 1,
          },
        ],
      },
      '203.0.113.11',
    );

    expect(response.statusCode).toBe(400);
    expect(response._getJSONData().error).toBe('Invalid request');
  });

  it('rate limits repeated job creation attempts from the same client', async () => {
    for (let count = 0; count < 5; count += 1) {
      const response = await sendCreateJob(
        {
          sourceUrl: 'https://www.youtube.com/@Revealedrec/videos',
          format: 'mp3',
          quality: 'standard',
          items: [
            {
              id: 'one',
              url: 'https://example.com/one',
              title: 'Track one',
              index: 1,
            },
          ],
        },
        '203.0.113.12',
      );

      expect(response.statusCode).toBe(202);
    }

    const blocked = await sendCreateJob(
      {
        sourceUrl: 'https://www.youtube.com/@Revealedrec/videos',
        format: 'mp3',
        quality: 'standard',
        items: [
          {
            id: 'one',
            url: 'https://example.com/one',
            title: 'Track one',
            index: 1,
          },
        ],
      },
      '203.0.113.12',
    );

    expect(blocked.statusCode).toBe(429);
    expect(blocked._getJSONData().error).toContain('Too many conversion requests');
  });
});
