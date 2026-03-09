import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import {
  addTrackToMixProject,
  ApiError,
  createBatchJob,
  createMixProject as createMixProjectRequest,
  createSingleJob,
  deleteLibraryTracks as deleteLibraryTracksRequest,
  deleteMixProject as deleteMixProjectRequest,
  fetchHealth,
  fetchJob,
  fetchLibrary,
  fetchMixProjects,
  fetchRecommendations,
  importExistingLibraryTracks,
  inspectSource,
  renderMixPreview as renderMixPreviewRequest,
  resolveRecommendationSource,
  updateMixTrackOverlap as updateMixTrackOverlapRequest,
  uploadLibraryTracks,
} from './api';
import type {
  HealthResponse,
  JobRecord,
  LibrarySourceType,
  LibraryTrack,
  MixPreview,
  MixProject,
  MixProjectTimelineItem,
  OutputFormat,
  QualityPreset,
  RecommendationResponse,
  SourceEntry,
  SourceInspection,
} from './types';

type LengthPreset = 'all' | 'singles' | 'medium' | 'long';
type WorkspaceId = 'convert' | 'library' | 'mix' | 'similar';
type LibrarySort = 'newest' | 'oldest' | 'title' | 'duration' | 'size';
type SimilarSeed = {
  key: string;
  label: string;
  title: string;
  artist?: string;
  sourceUrl?: string;
  sourceType: 'library' | 'job';
  relatedId: string;
};

type WorkspaceStat = {
  label: string;
  value: string;
  tone?: 'default' | 'good' | 'warn' | 'accent';
};

const workspaces: Array<{ id: WorkspaceId; label: string; hint: string }> = [
  { id: 'convert', label: 'Convert', hint: 'Analyze sources and run serial downloads' },
  { id: 'library', label: 'Library', hint: 'Browse local tracks and bulk actions' },
  { id: 'mix', label: 'Mix', hint: 'Arrange projects and tune transitions' },
  { id: 'similar', label: 'Similar', hint: 'Use finished tracks as recommendation seeds' },
];

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

function formatFileSize(sizeBytes: number) {
  if (sizeBytes >= 1024 * 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

function formatDb(value?: number) {
  if (value === undefined || Number.isNaN(value)) {
    return 'Unknown loudness';
  }

  return `${value.toFixed(1)} dB`;
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
  if (preset === 'all') {
    return true;
  }

  if (!durationSeconds || durationSeconds <= 0) {
    return false;
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
  if (seconds === undefined || Number.isNaN(seconds) || seconds < 0) {
    return 'Unknown length';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  const paddedSeconds = String(remainingSeconds).padStart(2, '0');

  if (hours > 0) {
    return `${hours}h ${minutes}m ${paddedSeconds}s`;
  }

  return `${minutes}m ${paddedSeconds}s`;
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

function formatQualityCopy(quality: QualityPreset, format: OutputFormat) {
  if (format === 'mp3') {
    return quality === 'high' ? 'Up to 320 kbps' : '192 kbps';
  }

  return quality === 'high' ? 'Up to 256 kbps' : '160 kbps';
}

async function triggerDownload(href: string, filename: string) {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
  await new Promise((resolve) => window.setTimeout(resolve, 180));
}

function compareDateDesc(left: string, right: string) {
  return new Date(right).getTime() - new Date(left).getTime();
}

export function App() {
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>('convert');
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<OutputFormat>('mp3');
  const [quality, setQuality] = useState<QualityPreset>('high');
  const [source, setSource] = useState<SourceInspection | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [selectedProgressIds, setSelectedProgressIds] = useState<string[]>([]);
  const [progressTopCount, setProgressTopCount] = useState('10');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadingInspect, setLoadingInspect] = useState(false);
  const [loadingStart, setLoadingStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [recommendationTargetId, setRecommendationTargetId] = useState<string | null>(null);
  const [recommendationSeed, setRecommendationSeed] = useState<SimilarSeed | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationResponse | null>(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [downloadingRecommendationId, setDownloadingRecommendationId] = useState<string | null>(null);
  const [lengthPreset, setLengthPreset] = useState<LengthPreset>('all');
  const [topPreviewCount, setTopPreviewCount] = useState('10');
  const [maxSizeMb, setMaxSizeMb] = useState<string>('');
  const [libraryTracks, setLibraryTracks] = useState<LibraryTrack[]>([]);
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  const [newestLibraryCount, setNewestLibraryCount] = useState('10');
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [uploadingLibrary, setUploadingLibrary] = useState(false);
  const [importingLibrary, setImportingLibrary] = useState(false);
  const [librarySearch, setLibrarySearch] = useState('');
  const [librarySort, setLibrarySort] = useState<LibrarySort>('newest');
  const [librarySourceFilter, setLibrarySourceFilter] = useState<LibrarySourceType | 'all'>('all');
  const [mixProjects, setMixProjects] = useState<MixProject[]>([]);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [mixProjectName, setMixProjectName] = useState('My first mix');
  const [mixLoading, setMixLoading] = useState(false);
  const [mixError, setMixError] = useState<string | null>(null);
  const [activeMixId, setActiveMixId] = useState<string | null>(null);
  const [selectedMixTrackId, setSelectedMixTrackId] = useState<string | null>(null);
  const [mixPreview, setMixPreview] = useState<MixPreview | null>(null);
  const [mixPreviewLoading, setMixPreviewLoading] = useState(false);
  const [selectedSimilarSeedKey, setSelectedSimilarSeedKey] = useState<string | null>(null);

  useEffect(() => {
    void fetchHealth()
      .then(setHealth)
      .catch((err: Error) => {
        setError(err.message);
      });

    void loadLibrary();
    void loadMixProjects();
  }, []);

  useEffect(() => {
    if (job?.status === 'completed') {
      void loadLibrary();
    }
  }, [job?.status]);

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

  useEffect(() => {
    const activeMix = mixProjects.find((project) => project.id === activeMixId) ?? mixProjects[0] ?? null;
    if (!activeMix) {
      setSelectedMixTrackId(null);
      return;
    }

    setSelectedMixTrackId((current) =>
      current && activeMix.timeline.some((item) => item.id === current) ? current : activeMix.timeline[0]?.id ?? null,
    );
  }, [mixProjects, activeMixId]);

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
      setTopPreviewCount('10');
      setMaxSizeMb('');
      setActiveWorkspace('convert');
    } catch (err) {
      setSource(null);
      setSelectedIds([]);
      setError(err instanceof Error ? err.message : 'Unable to inspect source');
    } finally {
      setLoadingInspect(false);
    }
  }

  async function loadLibrary() {
    setLibraryLoading(true);
    setLibraryError(null);

    try {
      const response = await fetchLibrary();
      setLibraryTracks(response.tracks);
      setSelectedLibraryIds((current) => current.filter((id) => response.tracks.some((track) => track.id === id)));
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : 'Unable to load library');
    } finally {
      setLibraryLoading(false);
    }
  }

  async function loadMixProjects() {
    setMixLoading(true);
    setMixError(null);

    try {
      const response = await fetchMixProjects();
      setMixProjects(response.projects);
      setActiveMixId((current) => current ?? response.projects[0]?.id ?? null);
      setSelectedProjectIds((current) => current.filter((id) => response.projects.some((project) => project.id === id)));
    } catch (err) {
      setMixError(err instanceof Error ? err.message : 'Unable to load mix projects');
    } finally {
      setMixLoading(false);
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
      setSelectedProgressIds([]);
      setProgressTopCount('10');
      setRecommendations(null);
      setRecommendationTargetId(null);
      setRecommendationSeed(null);
      setRecommendationError(null);
      setActiveWorkspace('convert');
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

  async function requestRecommendations(seed: SimilarSeed) {
    setRecommendationSeed(seed);
    setRecommendationTargetId(seed.relatedId);
    setRecommendationLoading(true);
    setRecommendationError(null);

    try {
      const response = await fetchRecommendations({
        title: seed.title,
        artist: seed.artist,
        sourceUrl: seed.sourceUrl,
      });
      setRecommendations(response);
      setSelectedSimilarSeedKey(seed.key);
      setActiveWorkspace('similar');
    } catch (err) {
      setRecommendations(null);
      setRecommendationError(err instanceof Error ? err.message : 'Unable to load recommendations');
    } finally {
      setRecommendationLoading(false);
    }
  }

  async function onLoadRecommendations(itemId: string) {
    const item = job?.items.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    await requestRecommendations({
      key: `job:${item.id}`,
      label: `${item.title} • Recent conversion`,
      title: item.title,
      artist: parseArtistFromTitle(item.title),
      sourceUrl: item.url,
      sourceType: 'job',
      relatedId: item.id,
    });
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
      setActiveWorkspace('convert');
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setRetryAt(err.retryAt ?? null);
      }
      setRecommendationError(err instanceof Error ? err.message : 'Unable to download recommendation');
    } finally {
      setDownloadingRecommendationId(null);
    }
  }

  function onSelectFirstProgressItems() {
    const count = Math.max(0, Number.parseInt(progressTopCount || '0', 10) || 0);
    setSelectedProgressIds((job?.items ?? []).slice(0, count).map((item) => item.id));
  }

  async function onDownloadSelectedProgressItems() {
    const items = job?.items.filter((item) => selectedProgressIds.includes(item.id) && item.downloadPath) ?? [];
    if (items.length === 0) {
      setError('Select at least one finished file to download.');
      return;
    }

    setError(null);

    for (const item of items) {
      await triggerDownload(item.downloadPath!, item.downloadName ?? `${item.title}.mp3`);
    }
  }

  function applyVisibleSelection(mode: 'select' | 'clear') {
    setSelectedIds(mode === 'select' ? visibleEntries.map((entry) => entry.id) : []);
  }

  function onSelectTopPreviewItems() {
    const count = Math.max(0, Number.parseInt(topPreviewCount || '0', 10) || 0);
    const topIds = visibleEntries.slice(0, count).map((entry) => entry.id);
    setSelectedIds(topIds);
  }

  async function onImportExistingLibrary() {
    setImportingLibrary(true);
    setLibraryError(null);

    try {
      await importExistingLibraryTracks();
      await loadLibrary();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : 'Unable to import existing downloads');
    } finally {
      setImportingLibrary(false);
    }
  }

  async function onUploadLibraryFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      return;
    }

    setUploadingLibrary(true);
    setLibraryError(null);

    try {
      await uploadLibraryTracks(files);
      await loadLibrary();
      event.target.value = '';
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : 'Unable to upload files');
    } finally {
      setUploadingLibrary(false);
    }
  }

  async function onCreateMixProject() {
    setMixLoading(true);
    setMixError(null);

    try {
      const response = await createMixProjectRequest(mixProjectName);
      setMixProjects((current) => [response.project, ...current]);
      setActiveMixId(response.project.id);
      setMixProjectName('');
      setSelectedProjectIds([]);
      setMixPreview(null);
      setActiveWorkspace('mix');
    } catch (err) {
      setMixError(err instanceof Error ? err.message : 'Unable to create mix project');
    } finally {
      setMixLoading(false);
    }
  }

  async function onAddTrackToMix(trackId: string) {
    if (!activeMixId) {
      setMixError('Create a mix project first.');
      setActiveWorkspace('mix');
      return;
    }

    setMixLoading(true);
    setMixError(null);

    try {
      const response = await addTrackToMixProject(activeMixId, trackId);
      setMixProjects((current) => current.map((project) => (project.id === response.project.id ? response.project : project)));
      setMixPreview(null);
      setActiveWorkspace('mix');
    } catch (err) {
      setMixError(err instanceof Error ? err.message : 'Unable to add track to mix');
    } finally {
      setMixLoading(false);
    }
  }

  async function onAddSelectedLibraryTracksToMix() {
    if (!activeMixId) {
      setMixError('Create a mix project first.');
      setActiveWorkspace('mix');
      return;
    }

    const selectedTracks = visibleLibraryTracks.filter((track) => selectedLibraryIds.includes(track.id));
    if (selectedTracks.length === 0) {
      setLibraryError('Select at least one visible track to add to the active mix.');
      return;
    }

    setMixLoading(true);
    setMixError(null);

    try {
      let latestProject: MixProject | null = null;
      for (const track of selectedTracks) {
        const response = await addTrackToMixProject(activeMixId, track.id);
        latestProject = response.project;
      }

      if (latestProject) {
        setMixProjects((current) => current.map((project) => (project.id === latestProject.id ? latestProject : project)));
      }
      setMixPreview(null);
      setActiveWorkspace('mix');
    } catch (err) {
      setMixError(err instanceof Error ? err.message : 'Unable to add selected tracks to mix');
    } finally {
      setMixLoading(false);
    }
  }

  async function onDeleteSelectedMixProjects() {
    if (selectedProjectIds.length === 0) {
      setMixError('Select at least one project to delete.');
      return;
    }

    setMixLoading(true);
    setMixError(null);

    try {
      await Promise.all(selectedProjectIds.map((projectId) => deleteMixProjectRequest(projectId)));
      setMixProjects((current) => {
        const selectedSet = new Set(selectedProjectIds);
        const next = current.filter((project) => !selectedSet.has(project.id));
        setActiveMixId((active) => {
          if (!active || !selectedSet.has(active)) {
            return active;
          }

          return next[0]?.id ?? null;
        });
        return next;
      });
      setSelectedProjectIds([]);
      setMixPreview((current) => (current && selectedProjectIds.includes(current.projectId) ? null : current));
    } catch (err) {
      setMixError(err instanceof Error ? err.message : 'Unable to delete mix project');
    } finally {
      setMixLoading(false);
    }
  }

  async function onDeleteSelectedLibraryTracks() {
    if (selectedLibraryIds.length === 0) {
      setLibraryError('Select at least one track to delete.');
      return;
    }

    setLibraryLoading(true);
    setLibraryError(null);

    try {
      const response = await deleteLibraryTracksRequest(selectedLibraryIds);
      setLibraryTracks(response.tracks);
      setSelectedLibraryIds([]);
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : 'Unable to delete selected tracks');
    } finally {
      setLibraryLoading(false);
    }
  }

  function onSelectNewestLibraryTracks() {
    const count = Math.max(0, Number.parseInt(newestLibraryCount || '0', 10) || 0);
    setSelectedLibraryIds(sortedLibraryTracks.slice(0, count).map((track) => track.id));
  }

  async function onDownloadSelectedLibraryTracks() {
    const selectedTracks = libraryTracks.filter((track) => selectedLibraryIds.includes(track.id));
    if (selectedTracks.length === 0) {
      setLibraryError('Select at least one track to download.');
      return;
    }

    setLibraryError(null);

    for (const track of selectedTracks) {
      await triggerDownload(track.filePath, track.originalFileName || `${track.title}.${track.format}`);
    }
  }

  async function onUpdateMixTrackOverlap(trackId: string, overlapSeconds: number) {
    if (!activeMixId) {
      return;
    }

    setMixLoading(true);
    setMixError(null);

    try {
      const response = await updateMixTrackOverlapRequest(activeMixId, trackId, overlapSeconds);
      setMixProjects((current) => current.map((project) => (project.id === response.project.id ? response.project : project)));
      setMixPreview(null);
    } catch (err) {
      setMixError(err instanceof Error ? err.message : 'Unable to update overlap');
    } finally {
      setMixLoading(false);
    }
  }

  async function onRenderMixPreview() {
    if (!activeMixId) {
      setMixError('Create a mix project first.');
      return;
    }

    setMixPreviewLoading(true);
    setMixError(null);

    try {
      const response = await renderMixPreviewRequest(activeMixId);
      setMixPreview(response.preview);
    } catch (err) {
      setMixError(err instanceof Error ? err.message : 'Unable to render preview');
    } finally {
      setMixPreviewLoading(false);
    }
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
  const visibleSelectedCount = visibleEntries.filter((entry) => selectedIds.includes(entry.id)).length;
  const selectedEstimatedSeconds = selectedItems.reduce((sum, entry) => sum + (entry.durationSeconds ?? 0), 0);
  const selectedEstimatedSizeMb = selectedItems.reduce(
    (sum, entry) => sum + (estimateSizeMb(entry.durationSeconds, format, quality) ?? 0),
    0,
  );
  const retryMessage =
    retryAt !== null ? `Rate limit reached. Try again in ${Math.max(0, Math.ceil((retryAt - now) / 1000))}s.` : null;
  const activeItem = job?.items.find((item) => item.id === job.currentItemId) ?? null;
  const activeMix = mixProjects.find((project) => project.id === activeMixId) ?? mixProjects[0] ?? null;
  const activeMixPreview = activeMix && mixPreview?.projectId === activeMix.id ? mixPreview : null;
  const isMixPreviewOutdated =
    Boolean(activeMix && activeMixPreview) &&
    new Date(activeMixPreview!.renderedAt).getTime() < new Date(activeMix.updatedAt).getTime();
  const mixPreviewState = mixPreviewLoading
    ? 'rendering'
    : !activeMix || activeMix.timeline.length === 0
      ? 'none'
      : !activeMixPreview
        ? 'none'
        : isMixPreviewOutdated
          ? 'outdated'
          : 'ready';
  const convertButtonLabel =
    format === 'mp3'
      ? selectedItems.length > 0
        ? `Convert ${selectedItems.length} ${selectedItems.length === 1 ? 'track' : 'tracks'} to MP3`
        : 'Convert to MP3'
      : selectedItems.length > 0
        ? `Convert ${selectedItems.length} ${selectedItems.length === 1 ? 'track' : 'tracks'} to M4A`
        : 'Convert to M4A';

  const sortedLibraryTracks = useMemo(() => {
    const tracks = [...libraryTracks];

    tracks.sort((left, right) => {
      if (librarySort === 'oldest') {
        return compareDateDesc(right.createdAt, left.createdAt);
      }

      if (librarySort === 'title') {
        return left.title.localeCompare(right.title);
      }

      if (librarySort === 'duration') {
        return (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0);
      }

      if (librarySort === 'size') {
        return right.sizeBytes - left.sizeBytes;
      }

      return compareDateDesc(left.createdAt, right.createdAt);
    });

    return tracks;
  }, [libraryTracks, librarySort]);

  const visibleLibraryTracks = useMemo(() => {
    const needle = librarySearch.trim().toLowerCase();

    return sortedLibraryTracks.filter((track) => {
      const matchesText =
        needle.length === 0 ||
        track.title.toLowerCase().includes(needle) ||
        (track.artist ?? '').toLowerCase().includes(needle) ||
        track.format.toLowerCase().includes(needle);
      const matchesSource = librarySourceFilter === 'all' || track.sourceType === librarySourceFilter;
      return matchesText && matchesSource;
    });
  }, [sortedLibraryTracks, librarySearch, librarySourceFilter]);

  const selectedLibraryTracks = useMemo(
    () => libraryTracks.filter((track) => selectedLibraryIds.includes(track.id)),
    [libraryTracks, selectedLibraryIds],
  );
  const singleSelectedLibraryTrack = selectedLibraryTracks.length === 1 ? selectedLibraryTracks[0] : null;
  const hasLibrarySelection = selectedLibraryIds.length > 0;

  const recentSimilarSeeds = useMemo(
    () =>
      job?.items
        .filter((item) => item.status === 'completed' && item.downloadPath)
        .map((item) => ({
          key: `job:${item.id}`,
          label: `${item.title} • Recent conversion`,
          title: item.title,
          artist: parseArtistFromTitle(item.title),
          sourceUrl: item.url,
          sourceType: 'job' as const,
          relatedId: item.id,
        })) ?? [],
    [job],
  );
  const librarySimilarSeeds = useMemo(
    () =>
      libraryTracks.map((track) => ({
        key: `library:${track.id}`,
        label: `${track.title} • Library`,
        title: track.title,
        artist: track.artist ?? parseArtistFromTitle(track.title),
        sourceUrl: track.sourceUrl,
        sourceType: 'library' as const,
        relatedId: track.id,
      })),
    [libraryTracks],
  );
  const similarSeeds = useMemo(() => [...recentSimilarSeeds, ...librarySimilarSeeds], [recentSimilarSeeds, librarySimilarSeeds]);

  useEffect(() => {
    setSelectedSimilarSeedKey((current) =>
      current && similarSeeds.some((seed) => seed.key === current) ? current : similarSeeds[0]?.key ?? null,
    );
  }, [similarSeeds]);

  const selectedSimilarSeed = similarSeeds.find((seed) => seed.key === selectedSimilarSeedKey) ?? null;
  const selectedMixTrack = activeMix?.timeline.find((item) => item.id === selectedMixTrackId) ?? activeMix?.timeline[0] ?? null;
  const selectedMixTrackIndex = selectedMixTrack ? activeMix?.timeline.findIndex((item) => item.id === selectedMixTrack.id) ?? -1 : -1;
  const progressCompletedItems = job?.items.filter((item) => item.downloadPath) ?? [];
  const convertWorkspaceStat =
    job && (job.status === 'running' || job.status === 'queued')
      ? `${job.completedCount}/${job.itemCount} complete`
      : source
        ? `${selectedItems.length} selected`
        : 'Idle';
  const mixWorkspaceStat = activeMix
    ? mixPreviewState === 'ready'
      ? 'Preview ready'
      : `${activeMix.timeline.length} tracks`
    : `${mixProjects.length} projects`;
  const similarWorkspaceStat = recommendations ? `${recommendations.recommendations.length} results` : `${similarSeeds.length} seeds`;
  const shellStats: WorkspaceStat[] = [
    { label: 'Library', value: `${libraryTracks.length} tracks` },
    { label: 'Mixes', value: `${mixProjects.length} projects` },
    { label: 'Converter', value: health?.dependencies.ready ? 'Ready' : 'Setup required', tone: health?.dependencies.ready ? 'good' : 'warn' },
    { label: 'Queue', value: job ? statusLabel(job.status) : 'Idle', tone: job?.status === 'running' ? 'accent' : 'default' },
  ];

  return (
    <main className="app-shell">
      <header className="top-shell surface-panel">
        <div className="top-shell__brand">
          <div className="brand-mark" aria-hidden="true">
            MD
          </div>
          <div>
            <span className="eyebrow">Local-first audio workspace</span>
            <h1>Music Downloader</h1>
            <p className="top-shell__copy">Convert, organize, and mix local tracks.</p>
          </div>
        </div>

        <div className="top-shell__status">
          {shellStats.map((stat) => (
            <ShellStat key={stat.label} label={stat.label} value={stat.value} tone={stat.tone} />
          ))}
        </div>
      </header>

      <nav className="workspace-tabs surface-panel" aria-label="Workspaces">
        {workspaces.map((workspace) => {
          const stat =
            workspace.id === 'convert'
              ? convertWorkspaceStat
              : workspace.id === 'library'
                ? hasLibrarySelection
                  ? `${selectedLibraryIds.length} selected`
                  : `${visibleLibraryTracks.length} visible`
                : workspace.id === 'mix'
                  ? mixWorkspaceStat
                  : similarWorkspaceStat;

          return (
            <WorkspaceTabButton
              key={workspace.id}
              label={workspace.label}
              hint={workspace.hint}
              stat={stat}
              active={activeWorkspace === workspace.id}
              onClick={() => setActiveWorkspace(workspace.id)}
            />
          );
        })}
      </nav>

      {retryMessage ? <Banner tone="warn">{retryMessage}</Banner> : null}
      {error ? <Banner tone="error">{error}</Banner> : null}

      <section className="workspace-panel">
        {activeWorkspace === 'convert' ? (
          <div className="workspace workspace--convert">
            <div className="workspace__header surface-panel">
              <WorkspaceHeaderIntro
                kicker="Convert"
                title="Analyze sources and queue conversion batches"
                copy="Analyze a URL and queue downloads."
                metrics={[
                  { label: 'Selection', value: source ? `${selectedItems.length}/${source.entryCount}` : '0/0' },
                  { label: 'Queue', value: job ? `${job.completedCount}/${job.itemCount}` : 'Idle' },
                ]}
                trailing={<LivePill ready={Boolean(health?.dependencies.ready)} />}
              />
            </div>

            <div className="workspace__body two-pane-layout">
              <div className="pane-stack">
                <section className="surface-panel convert-intake">
                  <SectionToolbar
                    title="Source intake"
                    detail={source ? source.title : 'Start with a single source URL'}
                    actions={
                      source ? (
                        <InspectorMetricCluster
                          items={[
                            { label: 'Found', value: `${source.entryCount}` },
                            { label: 'Runtime', value: formatDuration(source.estimatedTotalSeconds) },
                          ]}
                        />
                      ) : undefined
                    }
                  />
                  <form className="convert-form" onSubmit={onInspect}>
                    <label className="field field--wide">
                      <span>Source URL</span>
                      <input
                        type="url"
                        placeholder="https://www.youtube.com/watch?v=..."
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        required
                      />
                    </label>

                    <div className="convert-actions">
                      <button
                        className="primary-button"
                        type="submit"
                        disabled={loadingInspect || !health?.dependencies.ready}
                      >
                        {loadingInspect ? 'Analyzing...' : 'Analyze'}
                      </button>
                    </div>

                    <div className="option-grid">
                      <div className="option-group">
                        <span className="meta-label">Format</span>
                        <div className="segmented-grid">
                          {(['mp3', 'm4a'] as OutputFormat[]).map((option) => (
                            <button
                              key={option}
                              type="button"
                              className={`segment-button ${format === option ? 'is-active' : ''}`}
                              onClick={() => setFormat(option)}
                            >
                              <strong>{formatLabels[option]}</strong>
                              <span>{option === 'mp3' ? 'Most compatible' : 'Smaller files'}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="option-group">
                        <span className="meta-label">Quality</span>
                        <div className="segmented-grid">
                          {(['high', 'standard'] as QualityPreset[]).map((option) => (
                            <button
                              key={option}
                              type="button"
                              className={`segment-button ${quality === option ? 'is-active' : ''}`}
                              onClick={() => setQuality(option)}
                            >
                              <strong>{qualityLabels[option]}</strong>
                              <span>{formatQualityCopy(option, format)}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </form>
                </section>

                <section className="surface-panel">
                  <SectionHeader
                    kicker="Candidates"
                    title="Source inspection"
                    copy={
                      source
                        ? `${source.title} • ${source.entryCount} item${source.entryCount === 1 ? '' : 's'}`
                        : 'Analyze a source to inspect tracks.'
                    }
                  />

                  {source ? (
                    <>
                      <BulkActionBar
                        title={`${selectedItems.length} selected`}
                        detail={`${visibleEntries.length} shown • ${visibleSelectedCount} visible • ${selectedEstimatedSeconds > 0 ? formatDuration(selectedEstimatedSeconds) : 'No runtime yet'}`}
                        actions={
                          <>
                            <button type="button" className="secondary-button" onClick={() => setSelectedIds(source.entries.map((entry) => entry.id))}>
                              Select all
                            </button>
                            <button type="button" className="secondary-button" onClick={() => setSelectedIds([])}>
                              Clear all
                            </button>
                            <button type="button" className="secondary-button" onClick={() => applyVisibleSelection('select')}>
                              Select visible
                            </button>
                            <button type="button" className="secondary-button" onClick={() => applyVisibleSelection('clear')}>
                              Clear visible
                            </button>
                            <label className="field field--compact">
                              <span>Top count</span>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                inputMode="numeric"
                                value={topPreviewCount}
                                onChange={(event) => setTopPreviewCount(event.target.value)}
                              />
                            </label>
                            <button type="button" className="secondary-button" onClick={onSelectTopPreviewItems}>
                              Select first
                            </button>
                          </>
                        }
                        filters={
                          <>
                            <div className="chip-group" role="tablist" aria-label="Length filters">
                              {([
                                ['all', 'All'],
                                ['singles', 'Singles'],
                                ['medium', 'Medium'],
                                ['long', 'Long'],
                              ] as Array<[LengthPreset, string]>).map(([preset, label]) => (
                                <button
                                  key={preset}
                                  type="button"
                                  className={`chip-button ${lengthPreset === preset ? 'is-active' : ''}`}
                                  onClick={() => setLengthPreset(preset)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                            <label className="field field--compact">
                              <span>Max size MB</span>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                inputMode="numeric"
                                placeholder="Any"
                                value={maxSizeMb}
                                onChange={(event) => setMaxSizeMb(event.target.value)}
                              />
                            </label>
                          </>
                        }
                      />

                      <div className="list-header">
                        <span>Title</span>
                        <span>Details</span>
                        <span>Actions</span>
                      </div>
                      <div className="row-list">
                        {visibleEntries.map((entry) => {
                          const checked = selectedIds.includes(entry.id);
                          const liveItem = job?.items.find((item) => item.id === entry.id);
                          const rowTone = liveItem?.status === 'completed' ? 'success' : liveItem?.status === 'running' ? 'accent' : 'default';

                          return (
                            <SelectableRow
                              key={entry.id}
                              checked={checked}
                              onToggle={() =>
                                setSelectedIds((current) =>
                                  checked ? current.filter((id) => id !== entry.id) : [...current, entry.id],
                                )
                              }
                              title={entry.title}
                              subtitle={`${classifyEntry(entry.durationSeconds)} • ${formatDuration(entry.durationSeconds)}`}
                              metadata={[formatSizeMb(estimateSizeMb(entry.durationSeconds, format, quality)), `#${entry.index + 1}`]}
                              actions={
                                liveItem ? <StatusBadge status={liveItem.status}>{statusLabel(liveItem.status)}</StatusBadge> : <span className="row-note">Ready</span>
                              }
                              selected={checked}
                              tone={rowTone}
                            />
                          );
                        })}
                      </div>
                      {visibleEntries.length === 0 ? (
                        <EmptyBlock
                          title="No candidates match these filters"
                          copy="Adjust filters or inspect again."
                        />
                      ) : null}
                    </>
                  ) : (
                    <EmptyBlock
                      title="No source inspected yet"
                      copy="Paste a source URL to begin."
                    />
                  )}
                </section>
              </div>

              <aside className="inspector-stack">
                <section className="surface-panel">
                  <SectionHeader
                    kicker="Queue"
                    title="Serial conversion"
                    copy={
                      job
                        ? `${job.completedCount}/${job.itemCount} complete • ${statusLabel(job.status)}`
                        : 'Queue and downloads.'
                    }
                  />

                  {job ? (
                    <>
                      <BulkActionBar
                        title={`${selectedProgressIds.length} selected`}
                        detail={`${progressCompletedItems.length} file${progressCompletedItems.length === 1 ? '' : 's'} ready`}
                        actions={
                          <>
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => setSelectedProgressIds(job.items.map((item) => item.id))}
                            >
                              Select all
                            </button>
                            <button type="button" className="secondary-button" onClick={() => setSelectedProgressIds([])}>
                              Clear all
                            </button>
                            <label className="field field--compact">
                              <span>Top count</span>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                inputMode="numeric"
                                value={progressTopCount}
                                onChange={(event) => setProgressTopCount(event.target.value)}
                              />
                            </label>
                            <button type="button" className="secondary-button" onClick={onSelectFirstProgressItems}>
                              Select first
                            </button>
                            <button type="button" className="secondary-button" onClick={() => void onDownloadSelectedProgressItems()}>
                              Download selected
                            </button>
                          </>
                        }
                      />

                      <div className="inspector-summary-grid">
                        <InspectorMetric label="Completed" value={`${job.completedCount}/${job.itemCount}`} />
                        <InspectorMetric label="Failed" value={`${job.failedCount}`} />
                        <InspectorMetric label="Format" value={formatLabels[job.format]} />
                        <InspectorMetric label="Remaining" value={formatDuration(job.estimatedRemainingSeconds)} />
                      </div>

                      <div className="progress-hero">
                        <div>
                          <strong>{activeItem ? activeItem.title : 'Preparing batch'}</strong>
                          <p className="muted">{Math.round(job.progress)}% complete</p>
                        </div>
                        <div className="progress-track" aria-hidden="true">
                          <div className="progress-track__fill" style={{ width: `${job.progress}%` }} />
                        </div>
                      </div>

                      {progressCompletedItems.length > 0 ? (
                        <div className="ready-strip">
                          <strong>{progressCompletedItems.length} download-ready</strong>
                          <span>Completed items stay actionable while the rest of the queue continues.</span>
                        </div>
                      ) : null}

                      <div className="row-list row-list--compact">
                        {job.items.map((item) => {
                          const checked = selectedProgressIds.includes(item.id);
                          const rowTone = item.downloadPath ? 'success' : item.status === 'running' ? 'accent' : 'default';

                          return (
                            <SelectableRow
                              key={item.id}
                              checked={checked}
                              onToggle={() =>
                                setSelectedProgressIds((current) =>
                                  checked ? current.filter((id) => id !== item.id) : [...current, item.id],
                                )
                              }
                              title={item.title}
                              subtitle={`${formatDuration(item.durationSeconds)} • ${item.stage}`}
                              metadata={[`${Math.round(item.progress)}%`, statusLabel(item.status)]}
                              actions={
                                <div className="row-actions">
                                  {item.downloadPath ? (
                                    <a className="action-link" href={item.downloadPath} download={item.downloadName}>
                                      Download
                                    </a>
                                  ) : null}
                                  {item.downloadPath ? (
                                    <button
                                      type="button"
                                      className="secondary-button secondary-button--small"
                                      onClick={() => void onLoadRecommendations(item.id)}
                                      disabled={recommendationLoading && recommendationTargetId === item.id}
                                    >
                                      {recommendationLoading && recommendationTargetId === item.id ? 'Loading…' : 'Similar'}
                                    </button>
                                  ) : null}
                                </div>
                              }
                              selected={checked}
                              tone={rowTone}
                            />
                          );
                        })}
                      </div>

                      {job.status === 'completed' && progressCompletedItems.length > 0 ? (
                        <div className="next-step-card next-step-card--accent">
                          <strong>Batch complete</strong>
                          <p className="muted">Finished files were added to the library. Continue with playback, bulk actions, or move them into a mix.</p>
                          <button type="button" className="primary-button" onClick={() => setActiveWorkspace('library')}>
                            Continue in Library
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <EmptyBlock
                      title="Queue is idle"
                      copy="Start a batch to see progress here."
                    />
                  )}
                </section>

                <section className="surface-panel">
                  <SectionHeader
                    kicker="Selection"
                    title="Conversion summary"
                    copy={source ? 'Current selection.' : 'No selection yet.'}
                  />

                  {source ? (
                    <div className="summary-stack">
                      <InspectorMetric label="Source" value={source.kind === 'list' ? 'Playlist / list' : 'Single source'} />
                      <InspectorMetric label="Selected" value={`${selectedItems.length} items`} />
                      <InspectorMetric label="Runtime" value={formatDuration(selectedEstimatedSeconds || source.estimatedTotalSeconds)} />
                      <InspectorMetric
                        label="Estimated size"
                        value={selectedItems.length > 0 ? formatSizeMb(selectedEstimatedSizeMb) : 'Choose items'}
                      />
                      <button
                        type="button"
                        className="primary-button"
                        onClick={onStartConversion}
                        disabled={loadingStart || !health?.dependencies.ready || selectedItems.length === 0}
                      >
                        {loadingStart ? 'Starting conversion…' : convertButtonLabel}
                      </button>
                    </div>
                  ) : (
                    <EmptyBlock
                      title="No selection yet"
                      copy="Select tracks to convert."
                    />
                  )}
                </section>
              </aside>
            </div>
          </div>
        ) : null}

        {activeWorkspace === 'library' ? (
          <div className="workspace workspace--library">
            <div className="workspace__header surface-panel">
              <WorkspaceHeaderIntro
                kicker="Library"
                title="Local track browser"
                copy="Browse, download, and move tracks into a mix."
                metrics={[
                  { label: 'Visible', value: `${visibleLibraryTracks.length}` },
                  { label: 'Selected', value: `${selectedLibraryIds.length}` },
                ]}
              />
            </div>

            <div className="workspace__body library-layout">
              <div className="pane-stack">
                <section className="surface-panel">
                  <LibraryControlSurface
                    selectedCount={selectedLibraryIds.length}
                    visibleCount={visibleLibraryTracks.length}
                    totalCount={libraryTracks.length}
                    uploading={uploadingLibrary}
                    importing={importingLibrary}
                    refreshing={libraryLoading}
                    hasSelection={hasLibrarySelection}
                    newestCount={newestLibraryCount}
                    searchValue={librarySearch}
                    sortValue={librarySort}
                    sourceValue={librarySourceFilter}
                    onUpload={onUploadLibraryFiles}
                    onImportExisting={() => void onImportExistingLibrary()}
                    onRefresh={() => void loadLibrary()}
                    onNewestCountChange={setNewestLibraryCount}
                    onSelectNewest={onSelectNewestLibraryTracks}
                    onDownloadSelected={() => void onDownloadSelectedLibraryTracks()}
                    onAddSelectedToMix={() => void onAddSelectedLibraryTracksToMix()}
                    onDeleteSelected={() => void onDeleteSelectedLibraryTracks()}
                    onSearchChange={setLibrarySearch}
                    onSortChange={(value) => setLibrarySort(value as LibrarySort)}
                    onSourceChange={(value) => setLibrarySourceFilter(value as LibrarySourceType | 'all')}
                  />

                  {libraryError ? <Banner tone="error">{libraryError}</Banner> : null}

                  <div className="list-header">
                    <span>Track</span>
                    <span>Metadata</span>
                    <span>Actions</span>
                  </div>

                  {visibleLibraryTracks.length > 0 ? (
                    <div className="row-list">
                      {visibleLibraryTracks.map((track) => (
                        <LibraryTrackRow
                          key={track.id}
                          track={track}
                          checked={selectedLibraryIds.includes(track.id)}
                          mixLoading={mixLoading}
                          onToggleChecked={() =>
                            setSelectedLibraryIds((current) =>
                              current.includes(track.id) ? current.filter((id) => id !== track.id) : [...current, track.id],
                            )
                          }
                          onAddToMix={() => void onAddTrackToMix(track.id)}
                          onDownloadTrack={() =>
                            void triggerDownload(
                              track.filePath,
                              track.originalFileName || `${track.title}.${track.format}`,
                            )
                          }
                          onFindSimilar={() =>
                            void requestRecommendations({
                              key: `library:${track.id}`,
                              label: `${track.title} • Library`,
                              title: track.title,
                              artist: track.artist ?? parseArtistFromTitle(track.title),
                              sourceUrl: track.sourceUrl,
                              sourceType: 'library',
                              relatedId: track.id,
                            })
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <EmptyBlock
                      title="Library has no matching tracks"
                      copy="Change filters or add tracks."
                    />
                  )}
                </section>
              </div>

              <aside className="inspector-stack">
                <section className="surface-panel">
                  <SectionHeader
                    kicker="Downloads"
                    title="Download selection"
                    copy="Current download target."
                  />

                  {singleSelectedLibraryTrack ? (
                    <div className="summary-stack">
                      <StatusLine label="Ready to download" value={singleSelectedLibraryTrack.format.toUpperCase()} tone="accent" />
                      <strong className="inspector-title">{singleSelectedLibraryTrack.title}</strong>
                      <InspectorMetric label="Artist" value={singleSelectedLibraryTrack.artist || 'Unknown artist'} />
                      <InspectorMetric label="Duration" value={formatDuration(singleSelectedLibraryTrack.durationSeconds)} />
                      <InspectorMetric label="Format" value={singleSelectedLibraryTrack.format.toUpperCase()} />
                      <InspectorMetric label="Size" value={formatFileSize(singleSelectedLibraryTrack.sizeBytes)} />
                      <InspectorMetric label="Loudness" value={formatDb(singleSelectedLibraryTrack.meanVolumeDb)} />
                      <InspectorMetric label="Source" value={singleSelectedLibraryTrack.sourceType} />
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() =>
                          void triggerDownload(
                            singleSelectedLibraryTrack.filePath,
                            singleSelectedLibraryTrack.originalFileName ||
                              `${singleSelectedLibraryTrack.title}.${singleSelectedLibraryTrack.format}`,
                          )
                        }
                      >
                        Download track
                      </button>
                      <button type="button" className="secondary-button" onClick={() => void onAddTrackToMix(singleSelectedLibraryTrack.id)}>
                        Add to active mix
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          void requestRecommendations({
                            key: `library:${singleSelectedLibraryTrack.id}`,
                            label: `${singleSelectedLibraryTrack.title} • Library`,
                            title: singleSelectedLibraryTrack.title,
                            artist: singleSelectedLibraryTrack.artist ?? parseArtistFromTitle(singleSelectedLibraryTrack.title),
                            sourceUrl: singleSelectedLibraryTrack.sourceUrl,
                            sourceType: 'library',
                            relatedId: singleSelectedLibraryTrack.id,
                          })
                        }
                      >
                        Find similar tracks
                      </button>
                    </div>
                  ) : selectedLibraryTracks.length > 1 ? (
                    <div className="summary-stack">
                      <StatusLine label="Bulk download" value={`${selectedLibraryTracks.length} tracks ready`} tone="accent" />
                      <InspectorMetric label="Selected" value={`${selectedLibraryTracks.length} tracks`} />
                      <InspectorMetric
                        label="Combined size"
                        value={formatFileSize(selectedLibraryTracks.reduce((sum, track) => sum + track.sizeBytes, 0))}
                      />
                      <InspectorMetric
                        label="Combined runtime"
                        value={formatDuration(selectedLibraryTracks.reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0))}
                      />
                      <button type="button" className="primary-button" onClick={() => void onDownloadSelectedLibraryTracks()}>
                        Download selected
                      </button>
                      <button type="button" className="secondary-button" onClick={() => void onAddSelectedLibraryTracksToMix()}>
                        Add selected to active mix
                      </button>
                      <button type="button" className="quiet-danger-button" onClick={() => void onDeleteSelectedLibraryTracks()}>
                        Delete selected
                      </button>
                      <button type="button" className="secondary-button" onClick={() => setActiveWorkspace('mix')}>
                        Open Mix workspace
                      </button>
                    </div>
                  ) : (
                    <EmptyBlock
                      title="Select tracks to download"
                      copy="Select tracks to download."
                    />
                  )}
                </section>
              </aside>
            </div>
          </div>
        ) : null}

        {activeWorkspace === 'mix' ? (
          <div className="workspace workspace--mix">
            <div className="workspace__header surface-panel">
              <WorkspaceHeaderIntro
                kicker="Mix"
                title="Mix editor"
                copy="Arrange tracks and audition transitions."
                metrics={[
                  { label: 'Projects', value: `${mixProjects.length}` },
                  { label: 'Preview', value: mixPreviewState },
                ]}
              />
            </div>

            <div className="workspace__body mix-layout">
              <section className="surface-panel mix-column">
                <SectionHeader
                  kicker="Projects"
                  title="Mix projects"
                  copy="Projects."
                />

                <div className="summary-stack summary-stack--tight">
                  <label className="field">
                    <span>Project name</span>
                    <input
                      value={mixProjectName}
                      onChange={(event) => setMixProjectName(event.target.value)}
                      placeholder="Late-night warmup"
                    />
                  </label>
                  <button type="button" className="primary-button" onClick={() => void onCreateMixProject()} disabled={mixLoading}>
                    {mixLoading ? 'Saving…' : 'Create mix project'}
                  </button>
                </div>

                <BulkActionBar
                  title={`${selectedProjectIds.length} selected`}
                  detail={`${mixProjects.length} total`}
                  actions={
                    <>
                      <button type="button" className="secondary-button" onClick={() => setSelectedProjectIds(mixProjects.map((project) => project.id))}>
                        Select all
                      </button>
                      <button type="button" className="secondary-button" onClick={() => setSelectedProjectIds([])}>
                        Clear all
                      </button>
                      <button type="button" className="quiet-danger-button" onClick={() => void onDeleteSelectedMixProjects()}>
                        Delete selected
                      </button>
                    </>
                  }
                />

                {mixProjects.length > 0 ? (
                  <div className="row-list">
                    {mixProjects.map((project) => {
                      const checked = selectedProjectIds.includes(project.id);
                      const isActive = activeMixId === project.id;

                      return (
                        <SelectableRow
                          key={project.id}
                          checked={checked}
                          onToggle={() =>
                            setSelectedProjectIds((current) =>
                              checked ? current.filter((id) => id !== project.id) : [...current, project.id],
                            )
                          }
                          title={project.name}
                          subtitle={`${project.timeline.length} track${project.timeline.length === 1 ? '' : 's'} • ${formatDuration(project.totalDurationSeconds)}`}
                          metadata={[new Date(project.updatedAt).toLocaleDateString()]}
                          actions={
                            <button
                              type="button"
                              className={`secondary-button secondary-button--small ${isActive ? 'is-current' : ''}`}
                              onClick={() => setActiveMixId(project.id)}
                            >
                              {isActive ? 'Open' : 'Focus'}
                            </button>
                          }
                          selected={checked || isActive}
                          tone={isActive ? 'accent' : 'default'}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <EmptyBlock
                    title="No mix projects yet"
                      copy="Create a project to begin."
                  />
                )}

                {mixError ? <Banner tone="error">{mixError}</Banner> : null}
              </section>

              <section className="surface-panel mix-column mix-column--center">
                <SectionHeader
                  kicker="Sequence"
                  title={activeMix ? activeMix.name : 'Ordered arrangement'}
                  copy={
                    activeMix
                      ? `${activeMix.timeline.length} track${activeMix.timeline.length === 1 ? '' : 's'} • ${formatDuration(activeMix.totalDurationSeconds)}`
                      : 'Select or create a project.'
                  }
                />

                {activeMix ? (
                  activeMix.timeline.length > 0 ? (
                    <div className="mix-sequence">
                      {activeMix.timeline.map((item, index) => (
                        <div className="mix-sequence-block" key={item.id}>
                          <button
                            type="button"
                            className={`mix-track-card ${selectedMixTrack?.id === item.id ? 'is-active' : ''}`}
                            onClick={() => setSelectedMixTrackId(item.id)}
                          >
                            <span className="mix-track-card__index">{index + 1}</span>
                            <div className="mix-track-card__copy">
                              <strong>{item.title}</strong>
                              <span>
                                Starts {formatDuration(item.startSeconds)} • Ends {formatDuration(item.endSeconds)}
                              </span>
                            </div>
                            <span className="mix-track-card__length">{formatDuration(item.durationSeconds)}</span>
                          </button>

                          {index < activeMix.timeline.length - 1 ? (
                            <div
                              className={`transition-card ${selectedMixTrack?.id === item.id ? 'is-active' : ''}`}
                              onClick={() => setSelectedMixTrackId(item.id)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  setSelectedMixTrackId(item.id);
                                }
                              }}
                              role="button"
                              tabIndex={0}
                            >
                              <div className="transition-card__copy">
                                <strong>Transition to {activeMix.timeline[index + 1]?.title}</strong>
                                <span>{formatDuration(item.overlapSeconds)} overlap between tracks</span>
                              </div>
                              <label className="transition-card__control">
                                <span>Crossfade</span>
                                <input
                                  type="range"
                                  min="0"
                                  max="30"
                                  step="1"
                                  value={item.overlapSeconds}
                                  onChange={(event) => void onUpdateMixTrackOverlap(item.id, Number(event.target.value))}
                                  disabled={mixLoading}
                                />
                                <strong>{formatDuration(item.overlapSeconds)}</strong>
                              </label>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyBlock
                      title="No tracks in this project"
                      copy="Add tracks from Library."
                    />
                  )
                ) : (
                  <EmptyBlock
                    title="No active mix"
                      copy="Open or create a project."
                  />
                )}
              </section>

              <aside className="surface-panel mix-column">
                <SectionHeader
                  kicker="Inspector"
                  title="Transition and preview"
                  copy="Preview and transition state."
                />

                <div className="summary-stack">
                  <PreviewStateBadge state={mixPreviewState} />

                  {selectedMixTrack ? (
                    <>
                      <StatusLine
                        label="Transition target"
                        value={selectedMixTrackIndex >= 0 ? activeMix?.timeline[selectedMixTrackIndex + 1]?.title ?? 'Mix end' : 'Mix end'}
                        tone="accent"
                      />
                      <strong className="inspector-title">{selectedMixTrack.title}</strong>
                      <InspectorMetric label="Track duration" value={formatDuration(selectedMixTrack.durationSeconds)} />
                      <InspectorMetric label="Start time" value={formatDuration(selectedMixTrack.startSeconds)} />
                      <InspectorMetric label="End time" value={formatDuration(selectedMixTrack.endSeconds)} />
                      <InspectorMetric label="Outgoing crossfade" value={formatDuration(selectedMixTrack.overlapSeconds)} />
                    </>
                  ) : (
                    <EmptyBlock
                      title="No transition selected"
                      copy="Select a track or transition."
                    />
                  )}

                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void onRenderMixPreview()}
                    disabled={mixPreviewLoading || !activeMix || activeMix.timeline.length === 0}
                  >
                    {mixPreviewLoading ? 'Rendering preview…' : 'Render preview'}
                  </button>

                  {activeMixPreview ? (
                    <div className="preview-player-card">
                      <audio controls preload="none" src={activeMixPreview.filePath} />
                      <p className="muted">
                        Rendered {new Date(activeMixPreview.renderedAt).toLocaleString()} • {formatDuration(activeMixPreview.durationSeconds)}
                      </p>
                    </div>
                  ) : activeMix ? (
                    <div className="preview-player-card preview-player-card--empty">
                      <p className="muted">Render the current sequence to audition transitions without exporting the full mix.</p>
                    </div>
                  ) : null}
                </div>
              </aside>
            </div>
          </div>
        ) : null}

        {activeWorkspace === 'similar' ? (
          <div className="workspace workspace--similar">
            <div className="workspace__header surface-panel">
              <WorkspaceHeaderIntro
                kicker="Similar"
                title="Similar tracks"
                copy="Use a seed track and continue downloading."
                metrics={[
                  { label: 'Seeds', value: `${similarSeeds.length}` },
                  { label: 'Results', value: recommendations ? `${recommendations.recommendations.length}` : '0' },
                ]}
              />
            </div>

            <div className="workspace__body two-pane-layout">
              <section className="surface-panel">
                <SectionHeader
                  kicker="Seeds"
                  title="Choose a seed track"
                  copy="Choose a seed."
                />

                {similarSeeds.length > 0 ? (
                  <>
                    <BulkActionBar
                      title={selectedSimilarSeed ? 'Seed selected' : 'Choose a seed'}
                      detail={selectedSimilarSeed ? selectedSimilarSeed.label : 'No seed loaded'}
                      actions={
                        selectedSimilarSeed ? (
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => void requestRecommendations(selectedSimilarSeed)}
                            disabled={recommendationLoading}
                          >
                            {recommendationLoading ? 'Loading recommendations…' : 'Find similar'}
                          </button>
                        ) : undefined
                      }
                    />

                    <div className="row-list">
                      {recentSimilarSeeds.length > 0 ? (
                        <SeedGroup
                          title="Recent conversions"
                          seeds={recentSimilarSeeds}
                          selectedKey={selectedSimilarSeedKey}
                          onSelect={setSelectedSimilarSeedKey}
                        />
                      ) : null}
                      {librarySimilarSeeds.length > 0 ? (
                        <SeedGroup
                          title="Library tracks"
                          seeds={librarySimilarSeeds}
                          selectedKey={selectedSimilarSeedKey}
                          onSelect={setSelectedSimilarSeedKey}
                        />
                      ) : null}
                    </div>
                  </>
                ) : (
                  <EmptyBlock
                    title="No seed tracks available"
                      copy="Add or convert tracks first."
                  />
                )}
              </section>

              <aside className="inspector-stack">
                <section className="surface-panel">
                  <SectionHeader
                    kicker="Recommendations"
                    title={recommendationSeed ? `Based on ${recommendationSeed.title}` : 'Results'}
                    copy="Convert a result back into the queue."
                  />

                  {recommendationError ? <Banner tone="error">{recommendationError}</Banner> : null}

                  {recommendations ? (
                    <div className="row-list">
                      {recommendations.recommendations.map((item, index) => (
                        <div className="recommendation-card" key={item.id}>
                          <div className="recommendation-card__copy">
                            <strong>{index + 1}. {item.title}</strong>
                            <span>{item.artist}</span>
                            <span className="muted">{item.reason} • {item.source}</span>
                          </div>
                          <div className="recommendation-card__actions">
                            <a className="secondary-button secondary-button--small" href={item.sourceUrl ?? item.url} target="_blank" rel="noreferrer">
                              {item.sourceLabel ?? 'Open source'}
                            </a>
                            <button
                              type="button"
                              className="primary-button primary-button--small"
                              onClick={() => void onDownloadRecommendation(item)}
                              disabled={downloadingRecommendationId === item.id || !health?.dependencies.ready}
                            >
                              {downloadingRecommendationId === item.id ? 'Loading…' : 'Convert track'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyBlock
                      title="No recommendations loaded"
                      copy="Choose a seed and run a lookup."
                    />
                  )}
                </section>
              </aside>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ShellStat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'good' | 'warn' | 'accent' }) {
  return (
    <div className={`shell-stat shell-stat--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function WorkspaceTabButton({
  label,
  hint,
  stat,
  active,
  onClick,
}: {
  label: string;
  hint: string;
  stat: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`workspace-tab ${active ? 'is-active' : ''}`} onClick={onClick}>
      <div className="workspace-tab__topline">
        <strong>{label}</strong>
        <span className="workspace-tab__stat">{stat}</span>
      </div>
      <span>{hint}</span>
    </button>
  );
}

function WorkspaceHeaderIntro({
  kicker,
  title,
  copy,
  metrics,
  trailing,
}: {
  kicker: string;
  title: string;
  copy: string;
  metrics?: Array<{ label: string; value: string }>;
  trailing?: ReactNode;
}) {
  return (
    <div className="workspace-header-intro">
      <div className="workspace-header-intro__copy">
        <span className="section-kicker">{kicker}</span>
        <h2>{title}</h2>
        <p className="muted">{copy}</p>
      </div>
      <div className="workspace-header-intro__aside">
        {metrics?.length ? (
          <div className="workspace-header-intro__metrics">
            {metrics.map((metric) => (
              <InspectorMetric key={metric.label} label={metric.label} value={metric.value} />
            ))}
          </div>
        ) : null}
        {trailing}
      </div>
    </div>
  );
}

function SectionHeader({ kicker, title, copy }: { kicker: string; title: string; copy: string }) {
  return (
    <div className="section-header">
      <div>
        <span className="section-kicker">{kicker}</span>
        <h3>{title}</h3>
        <p className="muted">{copy}</p>
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'warn' | 'error'; children: string }) {
  return <p className={`banner banner--${tone}`}>{children}</p>;
}

function LivePill({ ready }: { ready: boolean }) {
  return <div className={`live-pill ${ready ? 'is-ready' : 'is-blocked'}`}>{ready ? 'Ready to convert' : 'Converter setup required'}</div>;
}

function SectionToolbar({ title, detail, actions }: { title: string; detail: string; actions?: ReactNode }) {
  return (
    <div className="section-toolbar">
      <div className="section-toolbar__copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {actions ? <div className="section-toolbar__actions">{actions}</div> : null}
    </div>
  );
}

function InspectorMetricCluster({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="inspector-metric-cluster">
      {items.map((item) => (
        <div className="inspector-mini-metric" key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function BulkActionBar({
  title,
  detail,
  actions,
  filters,
}: {
  title: string;
  detail: string;
  actions?: ReactNode;
  filters?: ReactNode;
}) {
  return (
    <div className="bulk-bar">
      <div className="bulk-bar__summary">
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {actions ? <div className="bulk-bar__actions">{actions}</div> : null}
      {filters ? <div className="bulk-bar__filters">{filters}</div> : null}
    </div>
  );
}

function LibraryControlSurface({
  selectedCount,
  visibleCount,
  totalCount,
  uploading,
  importing,
  refreshing,
  hasSelection,
  newestCount,
  searchValue,
  sortValue,
  sourceValue,
  onUpload,
  onImportExisting,
  onRefresh,
  onNewestCountChange,
  onSelectNewest,
  onAddSelectedToMix,
  onDownloadSelected,
  onDeleteSelected,
  onSearchChange,
  onSortChange,
  onSourceChange,
}: {
  selectedCount: number;
  visibleCount: number;
  totalCount: number;
  uploading: boolean;
  importing: boolean;
  refreshing: boolean;
  hasSelection: boolean;
  newestCount: string;
  searchValue: string;
  sortValue: string;
  sourceValue: string;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onImportExisting: () => void;
  onRefresh: () => void;
  onNewestCountChange: (value: string) => void;
  onSelectNewest: () => void;
  onAddSelectedToMix: () => void;
  onDownloadSelected: () => void;
  onDeleteSelected: () => void;
  onSearchChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onSourceChange: (value: string) => void;
}) {
  return (
    <div className={`library-control-surface ${hasSelection ? 'has-selection' : ''}`}>
      <div className="library-control-surface__status">
        <div className="library-control-surface__context">
          {hasSelection ? (
            <>
              <strong>{selectedCount} selected</strong>
              <span>Bulk actions ready.</span>
            </>
          ) : (
            <>
              <strong>Library controls</strong>
              <span>Select tracks for bulk actions.</span>
            </>
          )}
        </div>

        <div className="library-control-surface__stats" aria-label="Library statistics">
          <span>{visibleCount} visible</span>
          <span className="library-control-surface__dot" aria-hidden="true">
            •
          </span>
          <span>{totalCount} total</span>
        </div>
      </div>

      <div className="library-control-surface__toolbar">
        <div className="toolbar-group" role="group" aria-label="Library ingest and maintenance">
          <label className="toolbar-button toolbar-button--neutral file-button">
            <input type="file" accept="audio/*" multiple onChange={onUpload} disabled={uploading} />
            <span className="toolbar-button__icon">+</span>
            <span>{uploading ? 'Uploading...' : 'Upload'}</span>
          </label>
          <button type="button" className="toolbar-button toolbar-button--neutral" onClick={onImportExisting} disabled={importing}>
            <span className="toolbar-button__icon">I</span>
            <span>{importing ? 'Importing...' : 'Import existing'}</span>
          </button>
          <button type="button" className="toolbar-button toolbar-button--neutral" onClick={onRefresh} disabled={refreshing}>
            <span className="toolbar-button__icon">R</span>
            <span>{refreshing ? 'Refreshing...' : 'Refresh'}</span>
          </button>
        </div>

        <div className={`toolbar-group toolbar-group--selection ${hasSelection ? 'is-active' : 'is-idle'}`} role="group" aria-label="Selection actions">
          <button type="button" className="toolbar-button toolbar-button--primary" onClick={onDownloadSelected} disabled={!hasSelection}>
            <span className="toolbar-button__icon">D</span>
            <span>Download selected</span>
          </button>
          <button type="button" className="toolbar-button toolbar-button--neutral" onClick={onAddSelectedToMix} disabled={!hasSelection}>
            <span className="toolbar-button__icon">M</span>
            <span>Add selected to mix</span>
          </button>
          <button type="button" className="toolbar-button toolbar-button--quiet-danger" onClick={onDeleteSelected} disabled={!hasSelection}>
            <span className="toolbar-button__icon">X</span>
            <span>Delete selected</span>
          </button>
        </div>

        <div className="toolbar-group toolbar-group--utility" role="group" aria-label="Selection shortcut">
          <span className="toolbar-inline-label">Newest</span>
          <input
            className="toolbar-number-input"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={newestCount}
            onChange={(event) => onNewestCountChange(event.target.value)}
            aria-label="Newest track count"
          />
          <button type="button" className="toolbar-button toolbar-button--neutral" onClick={onSelectNewest}>
            <span className="toolbar-button__icon">N</span>
            <span>Select newest</span>
          </button>
        </div>
      </div>

      <div className="library-control-surface__filters">
        <label className="filter-control filter-control--search">
          <span>Search library</span>
          <input
            type="search"
            placeholder="Search title, artist, or format"
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </label>

        <label className="filter-control">
          <span>Sort</span>
          <select value={sortValue} onChange={(event) => onSortChange(event.target.value)}>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="title">Title</option>
            <option value="duration">Duration</option>
            <option value="size">Size</option>
          </select>
        </label>

        <label className="filter-control">
          <span>Source</span>
          <select value={sourceValue} onChange={(event) => onSourceChange(event.target.value)}>
            <option value="all">All sources</option>
            <option value="downloaded">Downloaded</option>
            <option value="uploaded">Uploaded</option>
            <option value="imported">Imported</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function StatusLine({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'accent';
}) {
  return (
    <div className={`status-line status-line--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SeedGroup({
  title,
  seeds,
  selectedKey,
  onSelect,
}: {
  title: string;
  seeds: SimilarSeed[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="seed-group">
      <div className="seed-group__header">
        <strong>{title}</strong>
        <span>{seeds.length}</span>
      </div>
      <div className="seed-group__rows">
        {seeds.map((seed) => (
          <button
            key={seed.key}
            type="button"
            className={`seed-row ${selectedKey === seed.key ? 'is-active' : ''}`}
            onClick={() => onSelect(seed.key)}
          >
            <span className="seed-row__title">{seed.title}</span>
            <span className="seed-row__meta">{seed.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectableRow({
  checked,
  onToggle,
  title,
  subtitle,
  metadata,
  actions,
  selected,
  tone = 'default',
}: {
  checked: boolean;
  onToggle: () => void;
  title: string;
  subtitle: string;
  metadata: string[];
  actions?: ReactNode;
  selected?: boolean;
  tone?: 'default' | 'accent' | 'success';
}) {
  return (
    <label className={`selectable-row selectable-row--${tone} ${selected ? 'is-selected' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <div className="selectable-row__main">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <div className="selectable-row__meta">
        {metadata.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <div className="selectable-row__actions">{actions}</div>
    </label>
  );
}

function StatusBadge({
  status,
  children,
}: {
  status: JobRecord['status'] | JobRecord['items'][number]['status'];
  children: string;
}) {
  return <span className={`status-badge status-badge--${status}`}>{children}</span>;
}

function InspectorMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="inspector-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
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

function PreviewStateBadge({ state }: { state: 'none' | 'ready' | 'outdated' | 'rendering' }) {
  const labels = {
    none: 'No preview rendered',
    ready: 'Preview ready',
    outdated: 'Preview outdated',
    rendering: 'Rendering preview',
  } as const;

  return <div className={`preview-state preview-state--${state}`}>{labels[state]}</div>;
}

function LibraryTrackRow({
  track,
  checked,
  mixLoading,
  onToggleChecked,
  onAddToMix,
  onDownloadTrack,
  onFindSimilar,
}: {
  track: LibraryTrack;
  checked: boolean;
  mixLoading: boolean;
  onToggleChecked: () => void;
  onAddToMix: () => void;
  onDownloadTrack: () => void;
  onFindSimilar: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);

  return (
    <div className={`selectable-row selectable-row--library ${checked ? 'is-selected' : ''}`}>
      <audio
        ref={audioRef}
        preload="none"
        src={track.filePath}
        onTimeUpdate={() => setCurrentSeconds(audioRef.current?.currentTime ?? 0)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentSeconds(0);
        }}
      />

      <label className="selectable-row__checkbox">
        <input type="checkbox" checked={checked} onChange={onToggleChecked} />
      </label>

      <div className="selectable-row__main">
        <strong>{track.title}</strong>
        <span>
          {track.artist || 'Unknown artist'} • {track.format.toUpperCase()} • {formatDuration(track.durationSeconds)}
        </span>
      </div>

      <div className="selectable-row__meta">
        <span>{formatFileSize(track.sizeBytes)}</span>
        <span>{formatDb(track.meanVolumeDb)}</span>
        <span>{track.sourceType}</span>
        <span>
          {formatDuration(Math.floor(currentSeconds))} / {formatDuration(track.durationSeconds ?? 0)}
        </span>
      </div>

      <div className="selectable-row__actions row-actions">
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            if (isPlaying) {
              audioRef.current?.pause();
              return;
            }

            void audioRef.current?.play();
          }}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            if (audioRef.current) {
              audioRef.current.pause();
              audioRef.current.currentTime = 0;
            }
            setCurrentSeconds(0);
            setIsPlaying(false);
          }}
          aria-label="Stop"
        >
          ■
        </button>
        <button type="button" className="secondary-button secondary-button--small" onClick={onDownloadTrack}>
          Download
        </button>
        <button type="button" className="secondary-button secondary-button--small" onClick={onAddToMix} disabled={mixLoading}>
          Add to mix
        </button>
        <button type="button" className="secondary-button secondary-button--small" onClick={onFindSimilar}>
          Similar
        </button>
      </div>
    </div>
  );
}
