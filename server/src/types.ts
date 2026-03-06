export type OutputFormat = 'mp3' | 'm4a';
export type QualityPreset = 'standard' | 'high';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface ConversionRequest {
  url: string;
  format: OutputFormat;
  quality: QualityPreset;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  request: ConversionRequest;
  createdAt: string;
  updatedAt: string;
  progress: number;
  stage: string;
  error?: string;
  title?: string;
  downloadPath?: string;
  downloadName?: string;
  sourceUrl?: string;
}
