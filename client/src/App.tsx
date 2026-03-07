import { FormEvent, useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  createBatchJob,
  createSingleJob,
  fetchHealth,
  fetchJob,
  fetchRecommendations,
  inspectSource,
  resolveRecommendationSource,
} from './api';
import type {
  HealthResponse,
  JobRecord,
  OutputFormat,
  QualityPreset,
  RecommendationResponse,
  SourceEntry,
  SourceInspection,
} from './types';

type LengthPreset = 'all' | 'singles' | 'medium' | 'long';

const formatLabels: Record<OutputFormat, string> = {
  mp3: 'MP3',
  m4a: 'M4A',
};

const qualityLabels: Record<QualityPreset, string> = {
  standard: 'Standard',
  high: 'High',
};

const bitrateMap: Record<QualityPreset, Record<OutputFormat, number>> = {
  standard: {
    mp3: 192,
    m4a: 160,
  },
  high: {
    mp3: 320,
    m4a: 256,
  },
};

function estimateSizeMb(durationSeconds: number | undefined, format: OutputFormat, quality: QualityPreset) {
  if (!durationSeconds || durationSeconds <= 0) {
    return undefined;
  }

  const bitrateKbps = bitrateMap[quality][format];
  return (durationSeconds * bitrateKbps) / 8 / 1024;
}

function formatSizeMb(sizeMb: number | undefined) {
  if (!sizeMb || sizeMb <= 0) {
    return 'Unknown size';
  }

  if (sizeMb >= 1024) {
    return `~${(sizeMb / 1024).toFixed(2)} GB`;
  }

  return `~${sizeMb < 10 ? sizeMb.toFixed(1) : Math.round(sizeMb)} MB`;
}

function classifyEntry(durationSeconds?: number) {
  if (!durationSeconds || durationSeconds <= 0) {
    return 'Unknown';
  }

  if (durationSeconds < 12 * 60) {
    return 'Track';
  }

  if (durationSeconds <= 30 * 60) {
    return 'Medium mix';
  }

  return 'Long set';
}

function matchesPreset(durationSeconds: number | undefined, preset: LengthPreset) {
  if (preset === 'all' || !durationSeconds || durationSeconds <= 0) {
    return preset === 'all';
  }

  if (preset === 'singles') {
    return durationSeconds < 12 * 60;
  }

  if (preset === 'medium') {
    return durationSeconds >= 12 * 60 && durationSeconds <= 30 * 60;
  }

  return durationSeconds > 30 * 60;
}

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

function parseArtistFromTitle(title: string) {
  const separators = [' - ', ' – ', ' — '];
  for (const separator of separators) {
    const parts = title.split(separator);
    if (parts.length >= 2) {
      return parts[0].trim();
    }
  }

  return undefined;
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
  const [recommendationTargetId, setRecommendationTargetId] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationResponse | null>(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [downloadingRecommendationId, setDownloadingRecommendationId] = useState<string | null>(null);
  const [lengthPreset, setLengthPreset] = useState<LengthPreset>('all');
  const [maxSizeMb, setMaxSizeMb] = useState<string>('');

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
      setLengthPreset('all');
      setMaxSizeMb('');
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
      setRecommendations(null);
      setRecommendationTargetId(null);
      setRecommendationError(null);
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

  async function onLoadRecommendations(itemId: string) {
    const item = job?.items.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    setRecommendationTargetId(itemId);
    setRecommendationLoading(true);
    setRecommendationError(null);

    try {
      const response = await fetchRecommendations({
        title: item.title,
        artist: parseArtistFromTitle(item.title),
        sourceUrl: item.url,
      });
      setRecommendations(response);
    } catch (err) {
      setRecommendations(null);
      setRecommendationError(err instanceof Error ? err.message : 'Unable to load recommendations');
    } finally {
      setRecommendationLoading(false);
    }
  }

  async function onDownloadRecommendation(item: RecommendationResponse['recommendations'][number]) {
    setDownloadingRecommendationId(item.id);
    setRecommendationError(null);
    setError(null);
    setRetryAt(null);

    try {
      const resolved = await resolveRecommendationSource(item.sourceQuery);
      const response = await createSingleJob({
        url: resolved.source.url,
        format,
        quality,
      });

      setJob(response.job);
      setSource({
        sourceUrl: resolved.source.url,
        title: resolved.source.title,
        kind: 'single',
        entryCount: 1,
        entries: [resolved.source],
        estimatedTotalSeconds: resolved.source.durationSeconds,
      });
      setSelectedIds([resolved.source.id]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setRetryAt(err.retryAt ?? null);
      }
      setRecommendationError(err instanceof Error ? err.message : 'Unable to download recommendation');
    } finally {
      setDownloadingRecommendationId(null);
    }
  }

  function applyVisibleSelection(mode: 'select' | 'clear') {
    if (!source) {
      return;
    }

    const visibleIds = visibleEntries.map((entry) => entry.id);
    setSelectedIds((current) => {
      if (mode === 'select') {
        return Array.from(new Set([...current, ...visibleIds]));
      }

      return current.filter((id) => !visibleIds.includes(id));
    });
  }

  const selectedItems = useMemo(
    () => (source ? source.entries.filter((entry) => selectedIds.includes(entry.id)) : []),
    [selectedIds, source],
  );
  const maxSizeFilter = Number(maxSizeMb);
  const visibleEntries = useMemo(() => {
    if (!source) {
      return [];
    }

    return source.entries.filter((entry) => {
      const sizeMb = estimateSizeMb(entry.durationSeconds, format, quality);
      const matchesSize = !maxSizeMb || (Number.isFinite(maxSizeFilter) && sizeMb !== undefined && sizeMb <= maxSizeFilter);
      return matchesPreset(entry.durationSeconds, lengthPreset) && matchesSize;
    });
  }, [source, format, quality, lengthPreset, maxSizeMb, maxSizeFilter]);
  const visibleIds = visibleEntries.map((entry) => entry.id);
  const visibleSelectedCount = visibleEntries.filter((entry) => selectedIds.includes(entry.id)).length;
  const selectedEstimatedSeconds = selectedItems.reduce((sum, entry) => sum + (entry.durationSeconds ?? 0), 0);
  const selectedEstimatedSizeMb = selectedItems.reduce(
    (sum, entry) => sum + (estimateSizeMb(entry.durationSeconds, format, quality) ?? 0),
    0,
  );
  const retryMessage =
    retryAt !== null ? `Rate limit reached. Try again in ${Math.max(0, Math.ceil((retryAt - now) / 1000))}s.` : null;
  const recommendationTarget = job?.items.find((item) => item.id === recommendationTargetId) ?? null;
  const activeItem = job?.items.find((item) => item.id === job.currentItemId) ?? null;
  const selectedSummaryLabel =
    selectedItems.length > 0 ? `${selectedItems.length} selected` : source ? 'Choose videos to convert' : 'Analyze a URL first';
  const showRecommendations =
    Boolean(recommendations) ||
    Boolean(recommendationError) ||
    Boolean(job?.items.some((item) => item.status === 'completed' && item.downloadPath));
  const convertButtonLabel =
    format === 'mp3'
      ? selectedItems.length > 0
        ? `Convert ${selectedItems.length} ${selectedItems.length === 1 ? 'track' : 'tracks'} to MP3`
        : 'Convert to MP3'
      : selectedItems.length > 0
        ? `Convert ${selectedItems.length} ${selectedItems.length === 1 ? 'track' : 'tracks'} to M4A`
        : 'Convert to M4A';

  return (
    <main className="app-shell">
      <section className="hero-card surface-card">
        <div className="hero-copy">
          <span className="eyebrow">Video to audio converter</span>
          <h1>Convert videos to audio in seconds</h1>
          <p className="lede">
            Paste a video, playlist, or channel URL. Preview what was found, choose format and quality, then convert and
            download clean audio files.
          </p>
        </div>

        <form className="hero-form" onSubmit={onInspect}>
          <div className="hero-input-row">
            <label className="field hero-url-field">
              <span>Paste video or playlist URL</span>
              <input
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
            </label>

            <button className="submit-button hero-action" type="submit" disabled={loadingInspect || !health?.dependencies.ready}>
              {loadingInspect ? 'Loading...' : 'Analyze'}
            </button>
          </div>

          <div className="settings-row">
            <div className="settings-block">
              <span className="meta-label">Output format</span>
              <div className="option-group">
                {(['mp3', 'm4a'] as OutputFormat[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`option-button ${format === option ? 'is-active' : ''}`}
                    onClick={() => setFormat(option)}
                  >
                    <strong>{formatLabels[option]}</strong>
                    <span>{option === 'mp3' ? 'Most compatible' : 'Smaller files'}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-block">
              <span className="meta-label">Audio quality</span>
              <div className="option-group">
                {(['high', 'standard'] as QualityPreset[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`option-button ${quality === option ? 'is-active' : ''}`}
                    onClick={() => setQuality(option)}
                  >
                    <strong>{quality === option ? qualityLabels[option] : qualityLabels[option]}</strong>
                    <span>{formatQualityCopy(option, format)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="hero-footer">
            <LivePill ready={Boolean(health?.dependencies.ready)} />
            <button
              className="submit-button primary-convert-button"
              type="button"
              onClick={onStartConversion}
              disabled={loadingStart || !health?.dependencies.ready || selectedItems.length === 0}
            >
              {loadingStart ? 'Starting conversion...' : convertButtonLabel}
            </button>
          </div>
        </form>

        {retryMessage ? <p className="warning-banner">{retryMessage}</p> : null}
        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      {source ? (
        <section className="summary-grid">
          <MetricCard
            label={source.kind === 'list' ? 'Playlist detected' : 'Video detected'}
            value={source.kind === 'list' ? 'Multiple videos found' : 'Single video ready'}
            detail={source.title}
          />
          <MetricCard label="Videos found" value={`${source.entryCount}`} detail={selectedSummaryLabel} />
          <MetricCard
            label="Total audio duration"
            value={formatDuration(source.estimatedTotalSeconds)}
            detail="Based on the videos found in this source."
          />
          <MetricCard
            label="Estimated file size"
            value={selectedItems.length > 0 ? formatSizeMb(selectedEstimatedSizeMb) : 'Choose videos first'}
            detail={selectedItems.length > 0 ? `For ${selectedItems.length} selected item${selectedItems.length === 1 ? '' : 's'}` : 'Shown for the videos you keep.'}
          />
        </section>
      ) : null}

      <section className="surface-card preview-card">
        <div className="section-heading">
          <div>
            <span className="section-kicker">Preview</span>
            <h2>Preview your videos</h2>
            <p className="muted">
              {source ? 'Choose the videos you want to convert.' : 'Analyze a URL to see the videos, duration, and estimated output before converting.'}
            </p>
          </div>
          {source ? (
            <div className="selection-summary">
              <strong>{selectedItems.length}</strong>
              <span>selected for conversion</span>
            </div>
          ) : null}
        </div>

        {source ? (
          <>
            <div className="preview-toolbar">
              <div className="selection-actions">
                <button type="button" className="ghost-button" onClick={() => setSelectedIds(source.entries.map((entry) => entry.id))}>
                  Select all
                </button>
                <button type="button" className="ghost-button" onClick={() => setSelectedIds([])}>
                  Clear all
                </button>
                <button type="button" className="ghost-button" onClick={() => applyVisibleSelection('select')}>
                  Select visible
                </button>
                <button type="button" className="ghost-button" onClick={() => applyVisibleSelection('clear')}>
                  Clear visible
                </button>
              </div>

              <div className="preview-filters">
                <div className="preset-group" role="tablist" aria-label="Video length filters">
                  {([
                    ['all', 'All'],
                    ['singles', 'Singles'],
                    ['medium', 'Medium'],
                    ['long', 'Long'],
                  ] as Array<[LengthPreset, string]>).map(([preset, label]) => (
                    <button
                      key={preset}
                      type="button"
                      className={`ghost-button filter-chip ${lengthPreset === preset ? 'is-active' : ''}`}
                      onClick={() => setLengthPreset(preset)}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <label className="field compact-field preview-size-field">
                  <span>Max size (MB)</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    placeholder="Any size"
                    value={maxSizeMb}
                    onChange={(event) => setMaxSizeMb(event.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="selection-strip">
              <span>{visibleEntries.length} videos shown</span>
              <span>{visibleSelectedCount} selected</span>
              <span>{selectedEstimatedSeconds > 0 ? formatDuration(selectedEstimatedSeconds) : 'No duration yet'}</span>
            </div>

            <div className="preview-list">
              {visibleEntries.map((entry) => {
                const checked = selectedIds.includes(entry.id);
                const liveItem = job?.items.find((item) => item.id === entry.id);
                const sizeLabel = formatSizeMb(estimateSizeMb(entry.durationSeconds, format, quality));

                return (
                  <label className={`preview-item ${checked ? 'is-selected' : ''}`} key={entry.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedIds((current) =>
                          checked ? current.filter((id) => id !== entry.id) : [...current, entry.id],
                        )
                      }
                    />
                    <PreviewArtwork entry={entry} />
                    <div className="preview-copy">
                      <strong>{entry.title}</strong>
                      <span className="muted">{formatDuration(entry.durationSeconds)}</span>
                    </div>
                    <div className="preview-meta">
                      <span>{sizeLabel}</span>
                      {liveItem ? <span className={`item-pill ${liveItem.status}`}>{statusLabel(liveItem.status)}</span> : null}
                    </div>
                  </label>
                );
              })}
            </div>
            {visibleEntries.length === 0 ? <p className="muted">No videos match the current filters.</p> : null}
          </>
        ) : (
          <EmptyBlock
            title="Your preview will appear here"
            copy="Paste a video, playlist, or channel URL above and you’ll be able to choose exactly what gets converted."
          />
        )}
      </section>

      <section className="surface-card progress-section">
        <div className="section-heading">
          <div>
            <span className="section-kicker">Progress</span>
            <h2>Conversion progress</h2>
            <p className="muted">
              {job ? 'Track what is converting, what is complete, and what is ready to download.' : 'Once you start a conversion, finished files and progress updates will show here.'}
            </p>
          </div>
          {job ? <span className={`item-pill ${job.status}`}>{statusLabel(job.status)}</span> : null}
        </div>

        {!job ? (
          <EmptyBlock
            title="No downloads yet"
            copy="Choose your videos, confirm the output settings, and start the conversion to see download progress here."
          />
        ) : (
          <>
            <div className="progress-overview">
              <MetricInline label="Completed" value={`${job.completedCount}/${job.itemCount}`} />
              <MetricInline label="Failed items" value={`${job.failedCount}`} />
              <MetricInline label="Time left" value={formatDuration(job.estimatedRemainingSeconds)} />
              <MetricInline label="Output format" value={formatLabels[job.format]} />
            </div>

            <div className="progress-card">
              <div className="progress-copy">
                <strong>{activeItem ? activeItem.title : 'Preparing your files'}</strong>
                <span>{Math.round(job.progress)}% complete</span>
              </div>
              <div className="progress-track" aria-hidden="true">
                <div className="progress-bar" style={{ width: `${job.progress}%` }} />
              </div>
            </div>

            <div className="progress-list">
              {job.items.map((item) => (
                <article className={`progress-item ${job.currentItemId === item.id ? 'is-live' : ''}`} key={item.id}>
                  <div className="progress-item-head">
                    <div>
                      <strong>{item.title}</strong>
                      <p className="muted">{formatDuration(item.durationSeconds)}</p>
                    </div>
                    <span className={`item-pill ${item.status}`}>{statusLabel(item.status)}</span>
                  </div>

                  <div className="mini-progress">
                    <div className="mini-progress-bar" style={{ width: `${item.progress}%` }} />
                  </div>

                  {item.downloadPath ? (
                    <div className="progress-item-actions">
                      <a className="download-link compact-link" href={item.downloadPath} download={item.downloadName}>
                        Download file
                      </a>
                      <button
                        type="button"
                        className="ghost-button compact-link"
                        onClick={() => onLoadRecommendations(item.id)}
                        disabled={recommendationLoading && recommendationTargetId === item.id}
                      >
                        {recommendationLoading && recommendationTargetId === item.id ? 'Loading similar tracks...' : 'Find similar'}
                      </button>
                    </div>
                  ) : null}

                  {item.error ? <p className="error-banner compact-banner">{item.error}</p> : null}
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      {showRecommendations ? (
        <section className="surface-card recommendation-section">
          <div className="section-heading">
            <div>
              <span className="section-kicker">More like this</span>
              <h2>Similar tracks</h2>
              <p className="muted">
                {recommendationTarget ? `Based on ${recommendationTarget.title}` : 'Use completed downloads to find similar music.'}
              </p>
            </div>
          </div>

          {recommendationError ? <p className="error-banner compact-banner">{recommendationError}</p> : null}

          {recommendations ? (
            <div className="recommendation-list">
              {recommendations.recommendations.map((item) => (
                <article className="recommendation-item" key={item.id}>
                  <div>
                    <strong>{item.title}</strong>
                    <p className="muted">
                      {item.artist} • {item.reason}
                    </p>
                  </div>
                  <div className="recommendation-actions">
                    <a className="link-chip" href={item.sourceUrl ?? item.url} target="_blank" rel="noreferrer">
                      {item.sourceLabel ?? 'Open source'}
                    </a>
                    <button
                      type="button"
                      className="ghost-button compact-link"
                      onClick={() => onDownloadRecommendation(item)}
                      disabled={downloadingRecommendationId === item.id || !health?.dependencies.ready}
                    >
                      {downloadingRecommendationId === item.id ? 'Loading...' : 'Convert this track'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyBlock
              title="No similar tracks yet"
              copy="After a download finishes, use Find similar to bring in a few related tracks."
            />
          )}
        </section>
      ) : null}
    </main>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="metric-card">
      <span className="meta-label">{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function MetricInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-inline">
      <span className="meta-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LivePill({ ready }: { ready: boolean }) {
  return <div className={`live-pill ${ready ? 'is-ready' : 'is-blocked'}`}>{ready ? 'Ready to convert' : 'Converter setup required'}</div>;
}

function EmptyBlock({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="empty-block">
      <span className="empty-badge">Waiting</span>
      <strong>{title}</strong>
      <p className="muted">{copy}</p>
    </div>
  );
}

function PreviewArtwork({ entry }: { entry: SourceEntry }) {
  return (
    <div className="preview-artwork" aria-hidden="true">
      <span>{entry.title.trim().charAt(0).toUpperCase() || 'A'}</span>
    </div>
  );
}

function formatQualityCopy(quality: QualityPreset, format: OutputFormat) {
  if (format === 'mp3') {
    return quality === 'high' ? 'Up to 320 kbps' : '192 kbps';
  }

  return quality === 'high' ? 'Up to 256 kbps' : '160 kbps';
}

function statusLabel(status: JobRecord['status'] | JobRecord['items'][number]['status']) {
  if (status === 'completed') {
    return 'Complete';
  }

  if (status === 'running') {
    return 'Converting';
  }

  if (status === 'failed') {
    return 'Failed';
  }

  return 'Waiting';
}
