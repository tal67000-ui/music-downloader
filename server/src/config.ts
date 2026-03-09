import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '..', '..', '.env');
const rootDir = path.resolve(__dirname, '..', '..');

dotenv.config({ path: envPath });

const port = Number(process.env.PORT ?? 8786);
const maxConcurrentJobs = Number(process.env.MAX_CONCURRENT_JOBS ?? 2);
const jobRetentionMs = Number(process.env.JOB_RETENTION_MS ?? 60 * 60 * 1000);

export const config = {
  port,
  host: process.env.HOST ?? '127.0.0.1',
  rootDir,
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  outputDir: path.resolve(rootDir, process.env.OUTPUT_DIR ?? './output'),
  tempDir: path.resolve(rootDir, process.env.TEMP_DIR ?? './tmp'),
  libraryDir: path.resolve(rootDir, process.env.LIBRARY_DIR ?? './data/library'),
  maxConcurrentJobs,
  jobRetentionMs,
  ytDlpPath: process.env.YT_DLP_PATH ?? 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  trustProxy: process.env.TRUST_PROXY === 'true',
  mediaProxyUrl: process.env.MEDIA_PROXY_URL?.trim() || null,
  lastfmApiKey: process.env.LASTFM_API_KEY?.trim() || null,
  musicBrainzContact: process.env.MUSICBRAINZ_CONTACT?.trim() || null,
};
