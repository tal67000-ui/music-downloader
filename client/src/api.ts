import type {
  ApiErrorDetails,
  HealthResponse,
  JobRecord,
  LibraryTrack,
  MixPreview,
  MixProject,
  OutputFormat,
  QualityPreset,
  RecommendationResponse,
  SourceEntry,
  SourceInspection,
} from './types';

export class ApiError extends Error {
  status: number;
  retryAt?: number;

  constructor(details: ApiErrorDetails) {
    super(details.message);
    this.name = 'ApiError';
    this.status = details.status;
    this.retryAt = details.retryAt;
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: Record<string, unknown> | null = null;

  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    if (!response.ok) {
      throw new ApiError({
        message: text.trim().startsWith('<!DOCTYPE')
          ? 'Server returned HTML instead of API JSON. Restart the app server so the latest backend routes are live.'
          : 'Server returned an invalid response.',
        status: response.status,
      });
    }

    throw new Error('Server returned an invalid response.');
  }

  if (!response.ok) {
    const retryHeader = response.headers.get('X-RateLimit-Reset');
    throw new ApiError({
      message: typeof body.error === 'string' ? body.error : 'Request failed',
      status: response.status,
      retryAt: retryHeader ? Number(retryHeader) : undefined,
    });
  }
  return body as T;
}

export async function fetchHealth() {
  const response = await fetch('/api/health');
  return parseJson<HealthResponse>(response);
}

export async function inspectSource(url: string) {
  const response = await fetch('/api/sources/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  return parseJson<{ source: SourceInspection }>(response);
}

export async function createBatchJob(input: {
  sourceUrl: string;
  format: OutputFormat;
  quality: QualityPreset;
  items: SourceEntry[];
}) {
  const response = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  return parseJson<{ job: JobRecord }>(response);
}

export async function createSingleJob(input: {
  url: string;
  format: OutputFormat;
  quality: QualityPreset;
}) {
  const response = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  return parseJson<{ job: JobRecord }>(response);
}

export async function fetchJob(id: string) {
  const response = await fetch(`/api/jobs/${id}`);
  return parseJson<{ job: JobRecord }>(response);
}

export async function fetchLibrary() {
  const response = await fetch('/api/library');
  return parseJson<{ tracks: LibraryTrack[] }>(response);
}

export async function importExistingLibraryTracks() {
  const response = await fetch('/api/library/import-existing', {
    method: 'POST',
  });

  return parseJson<{ tracks: LibraryTrack[] }>(response);
}

export async function uploadLibraryTracks(files: File[]) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('tracks', file);
  }

  const response = await fetch('/api/library/upload', {
    method: 'POST',
    body: formData,
  });

  return parseJson<{ tracks: LibraryTrack[] }>(response);
}

export async function deleteLibraryTracks(trackIds: string[]) {
  const response = await fetch('/api/library', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackIds }),
  });

  return parseJson<{ tracks: LibraryTrack[] }>(response);
}

export async function fetchMixProjects() {
  const response = await fetch('/api/mixes');
  return parseJson<{ projects: MixProject[] }>(response);
}

export async function createMixProject(name: string) {
  const response = await fetch('/api/mixes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });

  return parseJson<{ project: MixProject }>(response);
}

export async function addTrackToMixProject(projectId: string, trackId: string) {
  const response = await fetch(`/api/mixes/${projectId}/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackId }),
  });

  return parseJson<{ project: MixProject }>(response);
}

export async function updateMixTrackOverlap(projectId: string, trackId: string, overlapSeconds: number) {
  const response = await fetch(`/api/mixes/${projectId}/tracks/${trackId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overlapSeconds }),
  });

  return parseJson<{ project: MixProject }>(response);
}

export async function deleteMixProject(projectId: string) {
  const response = await fetch(`/api/mixes/${projectId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    await parseJson<Record<string, never>>(response);
  }
}

export async function renderMixPreview(projectId: string) {
  const response = await fetch(`/api/mixes/${projectId}/preview`, {
    method: 'POST',
  });

  return parseJson<{ preview: MixPreview }>(response);
}

export async function fetchRecommendations(input: {
  title: string;
  artist?: string;
  sourceUrl?: string;
}) {
  const response = await fetch('/api/recommendations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  return parseJson<RecommendationResponse>(response);
}

export async function resolveRecommendationSource(query: string) {
  const response = await fetch('/api/recommendations/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  return parseJson<{ source: SourceEntry }>(response);
}
