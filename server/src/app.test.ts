import { afterEach, describe, expect, it, vi } from 'vitest';
import httpMocks from 'node-mocks-http';
import type { Request, Response } from 'express';

import {
  handleAddTrackToMixProject,
  handleCreateJob,
  handleDeleteMixProject,
  handleCreateMixProject,
  handleImportLibraryOutputs,
  handleInspectSource,
  handleListLibrary,
  handleListMixProjects,
  handleRecommendations,
  handleRenderMixPreview,
  handleResolveRecommendation,
  handleUpdateMixTrack,
} from './app.js';
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

vi.mock('./libraryStore.js', () => ({
  listLibraryTracks: vi.fn(async () => [
    {
      id: 'track-1',
      title: 'Stored track',
      durationSeconds: 180,
      sizeBytes: 4560000,
      format: 'mp3',
      sourceType: 'downloaded',
      createdAt: '2026-03-06T00:00:00.000Z',
      filePath: '/library/files/track-1.mp3',
      waveformPath: '/library/waveforms/track-1.png',
      originalFileName: 'track-1.mp3',
    },
  ]),
  importExistingOutputs: vi.fn(async () => [
    {
      id: 'track-2',
      title: 'Imported track',
      durationSeconds: 240,
      sizeBytes: 5560000,
      format: 'mp3',
      sourceType: 'imported',
      createdAt: '2026-03-06T00:00:00.000Z',
      filePath: '/library/files/track-2.mp3',
      waveformPath: '/library/waveforms/track-2.png',
      originalFileName: 'track-2.mp3',
    },
  ]),
  ingestLibraryTrack: vi.fn(),
}));

vi.mock('./mixStore.js', () => ({
  listMixProjects: vi.fn(async () => [
    {
      id: 'mix-1',
      name: 'Warmup set',
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
      tracks: [],
      totalDurationSeconds: 0,
      timeline: [],
    },
  ]),
  createMixProject: vi.fn(async (name: string) => ({
    id: 'mix-2',
    name,
    createdAt: '2026-03-06T00:00:00.000Z',
    updatedAt: '2026-03-06T00:00:00.000Z',
    tracks: [],
    totalDurationSeconds: 0,
    timeline: [],
  })),
  addTrackToMixProject: vi.fn(async (_projectId: string, trackId: string) => ({
    id: 'mix-2',
    name: 'Warmup set',
    createdAt: '2026-03-06T00:00:00.000Z',
    updatedAt: '2026-03-06T00:00:00.000Z',
    tracks: [{ id: 'mix-track-1', trackId, overlapSeconds: 12 }],
    totalDurationSeconds: 180,
    timeline: [
      {
        id: 'mix-track-1',
        trackId,
        overlapSeconds: 12,
        title: 'Stored track',
        filePath: '/library/files/track-1.mp3',
        waveformPath: '/library/waveforms/track-1.png',
        durationSeconds: 180,
        startSeconds: 0,
        endSeconds: 180,
      },
    ],
  })),
  updateMixTrackOverlap: vi.fn(async (_projectId: string, mixTrackId: string, overlapSeconds: number) => ({
    id: 'mix-2',
    name: 'Warmup set',
    createdAt: '2026-03-06T00:00:00.000Z',
    updatedAt: '2026-03-06T00:00:00.000Z',
    tracks: [{ id: mixTrackId, trackId: 'track-1', overlapSeconds }],
    totalDurationSeconds: 180,
    timeline: [
      {
        id: mixTrackId,
        trackId: 'track-1',
        overlapSeconds,
        title: 'Stored track',
        filePath: '/library/files/track-1.mp3',
        waveformPath: '/library/waveforms/track-1.png',
        durationSeconds: 180,
        startSeconds: 0,
        endSeconds: 180,
      },
    ],
  })),
  deleteMixProject: vi.fn(async () => undefined),
  renderMixPreview: vi.fn(async (projectId: string) => ({
    projectId,
    filePath: `/library/previews/${projectId}.mp3?v=123`,
    renderedAt: '2026-03-06T00:00:00.000Z',
    durationSeconds: 170,
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

  async function sendLibraryList() {
    const req = httpMocks.createRequest<Request>({
      method: 'GET',
      url: '/api/library',
    });
    const res = httpMocks.createResponse<Response>();
    await handleListLibrary(req, res);
    return res;
  }

  async function sendLibraryImport() {
    const req = httpMocks.createRequest<Request>({
      method: 'POST',
      url: '/api/library/import-existing',
    });
    const res = httpMocks.createResponse<Response>();
    await handleImportLibraryOutputs(req, res);
    return res;
  }

  async function sendMixList() {
    const req = httpMocks.createRequest<Request>({
      method: 'GET',
      url: '/api/mixes',
    });
    const res = httpMocks.createResponse<Response>();
    await handleListMixProjects(req, res);
    return res;
  }

  async function sendCreateMix(payload: unknown) {
    const req = httpMocks.createRequest<Request>({
      method: 'POST',
      url: '/api/mixes',
      headers: { 'content-type': 'application/json' },
      body: payload as Record<string, unknown>,
    });
    const res = httpMocks.createResponse<Response>();
    await handleCreateMixProject(req, res);
    return res;
  }

  async function sendAddTrackToMix(projectId: string, payload: unknown) {
    const req = httpMocks.createRequest<Request>({
      method: 'POST',
      url: `/api/mixes/${projectId}/tracks`,
      params: { id: projectId },
      headers: { 'content-type': 'application/json' },
      body: payload as Record<string, unknown>,
    });
    const res = httpMocks.createResponse<Response>();
    await handleAddTrackToMixProject(req, res);
    return res;
  }

  async function sendUpdateMixTrack(projectId: string, mixTrackId: string, payload: unknown) {
    const req = httpMocks.createRequest<Request>({
      method: 'PATCH',
      url: `/api/mixes/${projectId}/tracks/${mixTrackId}`,
      params: { id: projectId, trackId: mixTrackId },
      headers: { 'content-type': 'application/json' },
      body: payload as Record<string, unknown>,
    });
    const res = httpMocks.createResponse<Response>();
    await handleUpdateMixTrack(req, res);
    return res;
  }

  async function sendDeleteMix(projectId: string) {
    const req = httpMocks.createRequest<Request>({
      method: 'DELETE',
      url: `/api/mixes/${projectId}`,
      params: { id: projectId },
    });
    const res = httpMocks.createResponse<Response>();
    await handleDeleteMixProject(req, res);
    return res;
  }

  async function sendRenderMixPreview(projectId: string) {
    const req = httpMocks.createRequest<Request>({
      method: 'POST',
      url: `/api/mixes/${projectId}/preview`,
      params: { id: projectId },
    });
    const res = httpMocks.createResponse<Response>();
    await handleRenderMixPreview(req, res);
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

  it('lists library tracks', async () => {
    const response = await sendLibraryList();

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().tracks).toHaveLength(1);
  });

  it('imports existing output files into the library', async () => {
    const response = await sendLibraryImport();

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().tracks).toHaveLength(1);
  });

  it('lists mix projects', async () => {
    const response = await sendMixList();

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().projects).toHaveLength(1);
  });

  it('creates a mix project', async () => {
    const response = await sendCreateMix({ name: 'Warmup set' });

    expect(response.statusCode).toBe(201);
    expect(response._getJSONData().project.name).toBe('Warmup set');
  });

  it('adds a track to a mix project', async () => {
    const response = await sendAddTrackToMix('mix-2', { trackId: 'track-1' });

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().project.timeline).toHaveLength(1);
  });

  it('updates overlap for a mix track', async () => {
    const response = await sendUpdateMixTrack('mix-2', 'mix-track-1', { overlapSeconds: 18 });

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().project.timeline[0].overlapSeconds).toBe(18);
  });

  it('deletes a mix project', async () => {
    const response = await sendDeleteMix('mix-2');

    expect(response.statusCode).toBe(204);
    expect(response._getData()).toBe('');
  });

  it('renders a mix preview', async () => {
    const response = await sendRenderMixPreview('mix-2');

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().preview.filePath).toContain('/library/previews/mix-2.mp3');
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
