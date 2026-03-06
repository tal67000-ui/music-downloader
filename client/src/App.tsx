import { FormEvent, useEffect, useMemo, useState } from 'react';

import { ApiError, createBatchJob, fetchHealth, fetchJob, inspectSource } from './api';
import type { HealthResponse, JobRecord, OutputFormat, QualityPreset, SourceEntry, SourceInspection } from './types';

const formatLabels: Record<OutputFormat, string> = {
  mp3: 'MP3',
  m4a: 'M4A',
};

const qualityLabels: Record<QualityPreset, string> = {
  standard: 'Standard',
  high: 'High',
};

function formatDuration(seconds?: number) {
  if (!seconds || seconds <= 0) {
    return 'Unknown length';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }

  return `${minutes}m ${remainingSeconds}s`;
}

export function App() {
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<OutputFormat>('mp3');
  const [quality, setQuality] = useState<QualityPreset>('high');
  const [source, setSource] = useState<SourceInspection | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadingInspect, setLoadingInspect] = useState(false);
  const [loadingStart, setLoadingStart] = useState(false);
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

  async function onInspect(event: FormEvent) {
    event.preventDefault();
    setLoadingInspect(true);
    setError(null);
    setJob(null);

    try {
      const response = await inspectSource(url);
      setSource(response.source);
      setSelectedIds(response.source.entries.map((entry) => entry.id));
    } catch (err) {
      setSource(null);
      setSelectedIds([]);
      setError(err instanceof Error ? err.message : 'Unable to inspect source');
    } finally {
      setLoadingInspect(false);
    }
  }

  async function onStartConversion() {
    if (!source) {
      return;
    }

    const selectedItems = source.entries.filter((entry) => selectedIds.includes(entry.id));
    if (selectedItems.length === 0) {
      setError('Select at least one video before starting the serial conversion.');
      return;
    }

    setLoadingStart(true);
    setError(null);
    setRetryAt(null);

    try {
      const response = await createBatchJob({
        sourceUrl: source.sourceUrl,
        format,
        quality,
        items: selectedItems,
      });
      setJob(response.job);
    } catch (err) {
      setJob(null);
      if (err instanceof ApiError && err.status === 429) {
        setRetryAt(err.retryAt ?? null);
      }
      setError(err instanceof Error ? err.message : 'Unable to start serial conversion');
    } finally {
      setLoadingStart(false);
    }
  }

  const selectedItems = useMemo(
    () => (source ? source.entries.filter((entry) => selectedIds.includes(entry.id)) : []),
    [selectedIds, source],
  );
  const selectedEstimatedSeconds = selectedItems.reduce((sum, entry) => sum + (entry.durationSeconds ?? 0), 0);
  const retryMessage =
    retryAt !== null ? `Rate limit reached. Try again in ${Math.max(0, Math.ceil((retryAt - now) / 1000))}s.` : null;

  return (
    <main className="page-shell batch-layout">
      <section className="hero-card">
        <div className="eyebrow">Serial downloader for playlists, channels, and source pages</div>
        <h1>Load a video list, choose tracks, then convert them one by one.</h1>
        <p className="lede">
          Paste a source page like a YouTube channel, playlist, or any supported multi-video feed. The app will list the
          available tracks, let you choose what to keep, and then run the conversions in sequence.
        </p>

        <form className="converter-form" onSubmit={onInspect}>
          <label className="field">
            <span>Source URL</span>
            <input
              type="url"
              placeholder="https://www.youtube.com/@Revealedrec/videos"
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

          <div className="action-row">
            <button className="submit-button" type="submit" disabled={loadingInspect || !health?.dependencies.ready}>
              {loadingInspect ? 'Loading video list...' : 'Load video list'}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={onStartConversion}
              disabled={loadingStart || !health?.dependencies.ready || selectedItems.length === 0}
            >
              {loadingStart ? 'Starting serial conversion...' : 'Start conversion'}
            </button>
          </div>
        </form>

        <div className="status-grid">
          <StatusPanel health={health} />
          <QualityPanel format={format} quality={quality} />
        </div>

        {source ? (
          <section className="source-panel">
            <div className="source-header">
              <div>
                <h2>{source.title}</h2>
                <p className="muted">
                  {source.entryCount} item{source.entryCount === 1 ? '' : 's'} detected
                </p>
              </div>
              <div className="selection-summary">
                <strong>{selectedItems.length} selected</strong>
                <span>{selectedEstimatedSeconds > 0 ? formatDuration(selectedEstimatedSeconds) : 'No time estimate yet'}</span>
              </div>
            </div>

            <div className="selection-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setSelectedIds(source.entries.map((entry) => entry.id))}
              >
                Select all
              </button>
              <button type="button" className="ghost-button" onClick={() => setSelectedIds([])}>
                Clear all
              </button>
            </div>

            <div className="entry-list">
              {source.entries.map((entry) => {
                const checked = selectedIds.includes(entry.id);
                const liveItem = job?.items.find((item) => item.id === entry.id);
                return (
                  <label className={`entry-row ${checked ? 'is-selected' : ''}`} key={entry.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedIds((current) =>
                          checked ? current.filter((id) => id !== entry.id) : [...current, entry.id],
                        )
                      }
                    />
                    <div className="entry-copy">
                      <strong>{entry.title}</strong>
                      <span className="muted">
                        #{entry.index} • {formatDuration(entry.durationSeconds)}
                      </span>
                    </div>
                    {liveItem ? <span className={`item-pill ${liveItem.status}`}>{liveItem.status}</span> : null}
                  </label>
                );
              })}
            </div>
          </section>
        ) : null}

        {retryMessage ? <p className="warning-banner">{retryMessage}</p> : null}
        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="result-card">
        <h2>Serial conversion run</h2>
        {!job ? (
          <p className="muted">Inspect a source, choose the tracks you want, then start the serial conversion.</p>
        ) : (
          <>
            <div className="job-meta">
              <div>
                <span className="meta-label">Status</span>
                <strong>{job.status}</strong>
              </div>
              <div>
                <span className="meta-label">Completed</span>
                <strong>
                  {job.completedCount}/{job.itemCount}
                </strong>
              </div>
              <div>
                <span className="meta-label">Failures</span>
                <strong>{job.failedCount}</strong>
              </div>
            </div>

            <div className="progress-track" aria-hidden="true">
              <div className="progress-bar" style={{ width: `${job.progress}%` }} />
            </div>

            <dl className="details-list">
              <div>
                <dt>Current stage</dt>
                <dd>{job.stage}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{job.sourceUrl}</dd>
              </div>
              <div>
                <dt>Output profile</dt>
                <dd>
                  {formatLabels[job.format]} / {qualityLabels[job.quality]}
                </dd>
              </div>
              <div>
                <dt>Estimated total</dt>
                <dd>{formatDuration(job.estimatedTotalSeconds)}</dd>
              </div>
              <div>
                <dt>Estimated remaining</dt>
                <dd>{formatDuration(job.estimatedRemainingSeconds)}</dd>
              </div>
            </dl>

            <div className="batch-item-list">
              {job.items.map((item) => (
                <article className={`batch-item ${job.currentItemId === item.id ? 'is-live' : ''}`} key={item.id}>
                  <div className="batch-item-top">
                    <div>
                      <strong>{item.title}</strong>
                      <p className="muted">
                        #{item.index} • {item.stage}
                      </p>
                    </div>
                    <span className={`item-pill ${item.status}`}>{item.status}</span>
                  </div>
                  <div className="mini-progress">
                    <div className="mini-progress-bar" style={{ width: `${item.progress}%` }} />
                  </div>
                  {item.downloadPath ? (
                    <a className="download-link compact-link" href={item.downloadPath} download={item.downloadName}>
                      Download {item.downloadName}
                    </a>
                  ) : null}
                  {item.error ? <p className="error-banner compact-banner">{item.error}</p> : null}
                </article>
              ))}
            </div>
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
        <li>{health.dependencies.ready ? 'Serial conversions enabled' : 'Install dependencies to enable conversions'}</li>
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
        ? 'Sequentially exports selected videos as MP3 at up to 320 kbps.'
        : 'Sequentially exports selected videos as MP3 at 192 kbps.'
      : quality === 'high'
        ? 'Sequentially exports selected videos as AAC/M4A at up to 256 kbps.'
        : 'Sequentially exports selected videos as AAC/M4A at 160 kbps.';

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
