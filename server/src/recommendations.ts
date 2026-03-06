import { config } from './config.js';
import type { RecommendationResponse, RecommendationResult, RecommendationSeed } from './types.js';

const recommendationCache = new Map<string, { expiresAt: number; value: RecommendationResponse }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

function normalizeText(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\((official|lyric|music) video\)/gi, '')
    .replace(/\[(official|lyric|music) video\]/gi, '')
    .trim();
}

function getPrimaryArtistName(artist?: string) {
  if (!artist) {
    return undefined;
  }

  return artist
    .split(/,|&| feat\. | featuring | vs\. | x /i)[0]
    ?.trim();
}

function buildSourceQuery(title: string, artist?: string) {
  return normalizeText([artist, title].filter(Boolean).join(' - '));
}

function buildYoutubeSearchUrl(query: string) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function toCacheKey(title: string, artist?: string) {
  return `${normalizeText(artist ?? '')}::${normalizeText(title)}`.toLowerCase();
}

function parseTrackHint(title: string, artist?: string): RecommendationSeed {
  if (artist?.trim()) {
    return {
      title: normalizeText(title),
      artist: normalizeText(artist),
      normalizedTitle: normalizeText(title),
      normalizedArtist: normalizeText(artist),
    };
  }

  const cleaned = normalizeText(title);
  const separators = [' - ', ' – ', ' — '];
  for (const separator of separators) {
    const parts = cleaned.split(separator);
    if (parts.length >= 2) {
      const [parsedArtist, ...rest] = parts;
      const parsedTitle = rest.join(separator);
      return {
        title: cleaned,
        artist: normalizeText(parsedArtist),
        normalizedTitle: normalizeText(parsedTitle),
        normalizedArtist: normalizeText(parsedArtist),
      };
    }
  }

  return {
    title: cleaned,
    normalizedTitle: cleaned,
  };
}

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': config.musicBrainzContact
        ? `music-downloader/0.1 (${config.musicBrainzContact})`
        : 'music-downloader/0.1',
      ...headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

async function canonicalizeWithMusicBrainz(seed: RecommendationSeed) {
  const queryParts = [];
  if (seed.normalizedTitle) {
    queryParts.push(`recording:"${seed.normalizedTitle}"`);
  }
  const artistForLookup = getPrimaryArtistName(seed.normalizedArtist) ?? seed.normalizedArtist;
  if (artistForLookup) {
    queryParts.push(`artist:"${artistForLookup}"`);
  }
  const query = queryParts.join(' AND ') || `"${seed.title}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=6`;
  const body = (await fetchJson(url)) as {
    recordings?: Array<{
      id: string;
      title: string;
      'artist-credit'?: Array<{ name?: string }>;
    }>;
  };

  const first = body.recordings?.[0];
  if (!first) {
    return null;
  }

  return {
    id: first.id,
    title: first.title,
    artist: first['artist-credit']?.map((credit) => credit.name).filter(Boolean).join(', ') || seed.artist || 'Unknown artist',
  };
}

async function getSameArtistRecommendations(seed: RecommendationSeed): Promise<RecommendationResult[]> {
  const artistForLookup = getPrimaryArtistName(seed.normalizedArtist) ?? seed.normalizedArtist;
  if (!artistForLookup) {
    return [];
  }

  const query = `artist:"${artistForLookup}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=12`;
  const body = (await fetchJson(url)) as {
    recordings?: Array<{
      id: string;
      title: string;
      'artist-credit'?: Array<{ name?: string }>;
    }>;
  };

  return (body.recordings ?? [])
    .map((recording) => {
      const artistName =
        recording['artist-credit']?.map((credit) => credit.name).filter(Boolean).join(', ') || seed.artist || 'Unknown artist';
      const sourceQuery = buildSourceQuery(recording.title, artistName);
      return {
        id: `mb-${recording.id}`,
        title: recording.title,
        artist: artistName,
        score: 0.48,
        reason: `More from ${artistForLookup}`,
        source: 'musicbrainz-artist' as const,
        sourceQuery,
        sourceUrl: buildYoutubeSearchUrl(sourceQuery),
        sourceLabel: 'YouTube search',
      };
    })
    .filter((item) => item.title.toLowerCase() !== (seed.normalizedTitle ?? seed.title).toLowerCase());
}

async function getLastFmTrackSimilar(seed: RecommendationSeed): Promise<RecommendationResult[]> {
  if (!config.lastfmApiKey || !seed.normalizedArtist || !seed.normalizedTitle) {
    return [];
  }

  const params = new URLSearchParams({
    method: 'track.getSimilar',
    api_key: config.lastfmApiKey,
    artist: seed.normalizedArtist,
    track: seed.normalizedTitle,
    format: 'json',
    limit: '8',
    autocorrect: '1',
  });

  const body = (await fetchJson(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`)) as {
    similartracks?: { track?: Array<{ name: string; match?: string; artist?: { name?: string }; url?: string }> };
  };

  return (body.similartracks?.track ?? []).map((track, index) => ({
    id: `lfm-track-${index}-${track.artist?.name ?? 'artist'}-${track.name}`,
    title: track.name,
    artist: track.artist?.name || 'Unknown artist',
    score: Number(track.match ?? 0.7) || 0.7,
    reason: 'Similar track',
    source: 'lastfm-track' as const,
    url: track.url,
    sourceQuery: buildSourceQuery(track.name, track.artist?.name || 'Unknown artist'),
    sourceUrl: buildYoutubeSearchUrl(buildSourceQuery(track.name, track.artist?.name || 'Unknown artist')),
    sourceLabel: 'YouTube search',
  }));
}

async function getLastFmArtistSimilar(seed: RecommendationSeed): Promise<RecommendationResult[]> {
  if (!config.lastfmApiKey || !seed.normalizedArtist) {
    return [];
  }

  const params = new URLSearchParams({
    method: 'artist.getSimilar',
    api_key: config.lastfmApiKey,
    artist: seed.normalizedArtist,
    format: 'json',
    limit: '5',
    autocorrect: '1',
  });

  const body = (await fetchJson(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`)) as {
    similarartists?: { artist?: Array<{ name: string; match?: string; url?: string }> };
  };

  return (body.similarartists?.artist ?? []).map((artist, index) => ({
    id: `lfm-artist-${index}-${artist.name}`,
    title: `Explore ${artist.name}`,
    artist: artist.name,
    score: Math.max(0.45, Number(artist.match ?? 0.6) * 0.7 || 0.6),
    reason: 'Similar artist',
    source: 'lastfm-artist' as const,
    url: artist.url,
    sourceQuery: buildSourceQuery('top tracks', artist.name),
    sourceUrl: buildYoutubeSearchUrl(buildSourceQuery('top tracks', artist.name)),
    sourceLabel: 'YouTube search',
  }));
}

function dedupeRecommendations(items: RecommendationResult[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.artist.toLowerCase()}::${item.title.toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function getRecommendations(input: {
  title: string;
  artist?: string;
  sourceUrl?: string;
}): Promise<RecommendationResponse> {
  const cacheKey = toCacheKey(input.title, input.artist);
  const cached = recommendationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const providerStatus: RecommendationResponse['providerStatus'] = {
    musicBrainz: 'skipped',
    lastfm: 'skipped',
  };

  const seed = parseTrackHint(input.title, input.artist);
  seed.sourceUrl = input.sourceUrl;

  try {
    const canonical = await canonicalizeWithMusicBrainz(seed);
    if (canonical) {
      seed.musicBrainzId = canonical.id;
      seed.normalizedTitle = normalizeText(canonical.title);
      seed.normalizedArtist = normalizeText(canonical.artist);
      seed.title = canonical.title;
      seed.artist = canonical.artist;
      providerStatus.musicBrainz = 'used';
    } else {
      providerStatus.musicBrainz = 'used';
    }
  } catch {
    providerStatus.musicBrainz = 'failed';
  }

  const recommendationLists: RecommendationResult[][] = [];

  try {
    const [sameTrack, similarArtists] = await Promise.all([
      getLastFmTrackSimilar(seed),
      getLastFmArtistSimilar(seed),
    ]);
    if (sameTrack.length > 0 || similarArtists.length > 0) {
      providerStatus.lastfm = 'used';
    }
    recommendationLists.push(sameTrack, similarArtists);
  } catch {
    providerStatus.lastfm = 'failed';
  }

  if (providerStatus.musicBrainz !== 'failed') {
    try {
      recommendationLists.push(await getSameArtistRecommendations(seed));
      providerStatus.musicBrainz = 'used';
    } catch {
      providerStatus.musicBrainz = 'failed';
    }
  }

  const recommendations = dedupeRecommendations(recommendationLists.flat())
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);

  const value: RecommendationResponse = {
    seed,
    recommendations,
    providerStatus,
  };

  recommendationCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  });

  return value;
}
