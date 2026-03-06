import { FormEvent, useEffect, useState } from 'react';

import { ApiError, createJob, fetchHealth, fetchJob } from './api';
import type { HealthResponse, JobRecord, OutputFormat, QualityPreset } from './types';

const formatLabels: Record<OutputFormat, string> = {
  mp3: 'MP3',
  m4a: 'M4A',
};

const qualityLabels: Record<QualityPreset, string> = {
  standard: 'Standard',
  high: 'High',
};

export function App() {
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<OutputFormat>('mp3');
  const [quality, setQuality] = useState<QualityPreset>('high');
  const [job, setJob] = useState<JobRecord | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void fetchHealth()
      .then(setHealth)
      .catch((err: Error) => {
        setError(err.message);
      });
  }, []);

  useEffect(() => {
    if (!retryAt) {
      return;
    }

    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) {
        setRetryAt(null);
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [retryAt]);

  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) {
      return;
    }

    const timer = window.setInterval(() => {
      void fetchJob(job.id)
        .then((response) => {
          setJob(response.job);
        })
        .catch((err: Error) => {
          setError(err.message);
        });
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [job]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setRetryAt(null);

    try {
      const response = await createJob({ url, format, quality });
      setJob(response.job);
    } catch (err) {
      setJob(null);
      if (err instanceof ApiError && err.status === 429) {
        setRetryAt(err.retryAt ?? null);
      }
      setError(err instanceof Error ? err.message : 'Unable to create job');
    } finally {
      setLoading(false);
    }
  }

  const retryMessage =
    retryAt !== null ? `Rate limit reached. Try again in ${Math.max(0, Math.ceil((retryAt - now) / 1000))}s.` : null;

  const submitDisabled = loading || !health?.dependencies.ready || (retryAt !== null && retryAt > now);

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div className="eyebrow">Audio extraction, optimized for listening</div>
        <h1>Convert any supported video or audio link into a clean download.</h1>
        <p className="lede">
          Paste a media URL, pick your format, and get a high-quality audio file you can stream or save.
        </p>

        <form className="converter-form" onSubmit={onSubmit}>
          <label className="field">
            <span>Media URL</span>
            <input
              type="url"
              placeholder="https://example.com/watch?v=..."
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Format</span>
              <select value={format} onChange={(event) => setFormat(event.target.value as OutputFormat)}>
                <option value="mp3">MP3</option>
                <option value="m4a">M4A</option>
              </select>
            </label>

            <label className="field">
              <span>Quality</span>
              <select value={quality} onChange={(event) => setQuality(event.target.value as QualityPreset)}>
                <option value="standard">Standard</option>
                <option value="high">High</option>
              </select>
            </label>
          </div>

          <button className="submit-button" type="submit" disabled={submitDisabled}>
            {loading ? 'Starting conversion...' : 'Convert to audio'}
          </button>
        </form>

        <div className="status-grid">
          <StatusPanel health={health} />
          <QualityPanel format={format} quality={quality} />
        </div>

        {retryMessage ? <p className="warning-banner">{retryMessage}</p> : null}
        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="result-card">
        <h2>Current job</h2>
        {!job ? (
          <p className="muted">No job submitted yet.</p>
        ) : (
          <>
            <div className="job-meta">
              <div>
                <span className="meta-label">Status</span>
                <strong>{job.status}</strong>
              </div>
              <div>
                <span className="meta-label">Stage</span>
                <strong>{job.stage}</strong>
              </div>
              <div>
                <span className="meta-label">Progress</span>
                <strong>{job.progress}%</strong>
              </div>
            </div>

            <div className="progress-track" aria-hidden="true">
              <div className="progress-bar" style={{ width: `${job.progress}%` }} />
            </div>

            <dl className="details-list">
              <div>
                <dt>Requested URL</dt>
                <dd>{job.sourceUrl}</dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>
                  {formatLabels[job.request.format]} / {qualityLabels[job.request.quality]}
                </dd>
              </div>
              {job.title ? (
                <div>
                  <dt>Detected title</dt>
                  <dd>{job.title}</dd>
                </div>
              ) : null}
            </dl>

            {job.status === 'completed' && job.downloadPath ? (
              <div className="download-panel">
                <audio controls src={job.downloadPath} className="audio-preview">
                  Your browser does not support audio playback.
                </audio>
                <a className="download-link" href={job.downloadPath} download={job.downloadName}>
                  Download {job.downloadName}
                </a>
              </div>
            ) : null}

            {job.status === 'failed' ? <p className="error-banner">{job.error}</p> : null}
          </>
        )}
      </section>
    </main>
  );
}

function StatusPanel({ health }: { health: HealthResponse | null }) {
  if (!health) {
    return (
      <div className="panel">
        <h3>System status</h3>
        <p className="muted">Checking dependencies...</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3>System status</h3>
      <ul className="status-list">
        <li>{health.dependencies.ffmpegInstalled ? 'ffmpeg ready' : 'ffmpeg missing'}</li>
        <li>{health.dependencies.ytDlpInstalled ? 'yt-dlp ready' : 'yt-dlp missing'}</li>
        <li>{health.dependencies.ready ? 'Conversions enabled' : 'Install dependencies to enable conversions'}</li>
      </ul>
    </div>
  );
}

function QualityPanel({
  format,
  quality,
}: {
  format: OutputFormat;
  quality: QualityPreset;
}) {
  const description =
    format === 'mp3'
      ? quality === 'high'
        ? 'Targets MP3 at 320 kbps when the source supports it.'
        : 'Targets MP3 at 192 kbps for a smaller download.'
      : quality === 'high'
        ? 'Targets AAC/M4A at 256 kbps for efficient high-quality playback.'
        : 'Targets AAC/M4A at 160 kbps for balanced size and clarity.';

  return (
    <div className="panel">
      <h3>Selected output</h3>
      <p>
        {formatLabels[format]} / {qualityLabels[quality]}
      </p>
      <p className="muted">{description}</p>
    </div>
  );
}
