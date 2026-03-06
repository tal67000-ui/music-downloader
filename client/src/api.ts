import type {
  ApiErrorDetails,
  HealthResponse,
  JobRecord,
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
  const body = await response.json();
  if (!response.ok) {
    const retryHeader = response.headers.get('X-RateLimit-Reset');
    throw new ApiError({
      message: body.error ?? 'Request failed',
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
