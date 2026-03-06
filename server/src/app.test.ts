import { afterEach, describe, expect, it, vi } from 'vitest';
import httpMocks from 'node-mocks-http';
import type { Request, Response } from 'express';

import { handleCreateJob } from './app.js';
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
  createJob: vi.fn((requestBody) => ({
    id: 'job-123',
    request: requestBody,
    status: 'queued',
    createdAt: '2026-03-06T00:00:00.000Z',
    updatedAt: '2026-03-06T00:00:00.000Z',
    progress: 0,
    stage: 'Queued',
    sourceUrl: requestBody.url,
  })),
  getJob: vi.fn(() => undefined),
  listJobs: vi.fn(() => []),
}));

describe('createApp', () => {
  afterEach(() => {
    resetRateLimits();
  });

  async function sendJson(payload: unknown, ip: string) {
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

  it('accepts a valid conversion request', async () => {
    const response = await sendJson(
      {
        url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
        format: 'mp3',
        quality: 'high',
      },
      '203.0.113.10',
    );

    expect(response.statusCode).toBe(202);
    expect(response._getJSONData().job.id).toBe('job-123');
    expect(response.getHeader('X-RateLimit-Remaining')).toBe('4');
  });

  it('rejects private network URLs', async () => {
    const response = await sendJson(
      {
        url: 'http://127.0.0.1:8080/song.mp3',
        format: 'mp3',
        quality: 'high',
      },
      '203.0.113.11',
    );

    expect(response.statusCode).toBe(400);
    expect(response._getJSONData().error).toBe('Invalid request');
  });

  it('rate limits repeated job creation attempts from the same client', async () => {
    for (let count = 0; count < 5; count += 1) {
      const response = await sendJson(
        {
          url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
          format: 'mp3',
          quality: 'standard',
        },
        '203.0.113.12',
      );

      expect(response.statusCode).toBe(202);
    }

    const blocked = await sendJson(
      {
        url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
        format: 'mp3',
        quality: 'standard',
      },
      '203.0.113.12',
    );

    expect(blocked.statusCode).toBe(429);
    expect(blocked._getJSONData().error).toContain('Too many conversion requests');
  });
});
