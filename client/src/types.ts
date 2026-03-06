export type OutputFormat = 'mp3' | 'm4a';
export type QualityPreset = 'standard' | 'high';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  progress: number;
  stage: string;
  error?: string;
  title?: string;
  downloadPath?: string;
  downloadName?: string;
  sourceUrl?: string;
  request: {
    url: string;
    format: OutputFormat;
    quality: QualityPreset;
  };
}

export interface HealthResponse {
  ok: boolean;
  dependencies: {
    ffmpegInstalled: boolean;
    ytDlpInstalled: boolean;
    ready: boolean;
  };
  maxConcurrentJobs: number;
}

export interface ApiErrorDetails {
  message: string;
  status: number;
  retryAt?: number;
}
