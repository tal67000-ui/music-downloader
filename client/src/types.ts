export type OutputFormat = 'mp3' | 'm4a';
export type QualityPreset = 'standard' | 'high';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type BatchItemStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface SourceEntry {
  id: string;
  url: string;
  title: string;
  index: number;
  durationSeconds?: number;
}

export interface SourceInspection {
  sourceUrl: string;
  title: string;
  kind: 'single' | 'list';
  entryCount: number;
  entries: SourceEntry[];
  estimatedTotalSeconds?: number;
}

export interface BatchItemRecord extends SourceEntry {
  status: BatchItemStatus;
  progress: number;
  stage: string;
  error?: string;
  downloadPath?: string;
  downloadName?: string;
}

export interface JobRecord {
  id: string;
  mode: 'single' | 'batch';
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  progress: number;
  stage: string;
  error?: string;
  title?: string;
  sourceUrl: string;
  format: OutputFormat;
  quality: QualityPreset;
  itemCount: number;
  completedCount: number;
  failedCount: number;
  estimatedTotalSeconds?: number;
  estimatedRemainingSeconds?: number;
  currentItemId?: string;
  items: BatchItemRecord[];
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
