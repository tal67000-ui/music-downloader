import { isIP } from 'node:net';
import { z } from 'zod';

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase();

  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const [a, b] = normalized.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (ipVersion === 6) {
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }

  return false;
}

const urlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }, 'Only http and https URLs are supported.')
  .refine((value) => {
    const parsed = new URL(value);
    return !isBlockedHostname(parsed.hostname);
  }, 'Local and private network URLs are not allowed.');

const sourceEntrySchema = z.object({
  id: z.string().min(1),
  url: urlSchema,
  title: z.string().min(1),
  index: z.number().int().positive(),
  durationSeconds: z.number().positive().optional(),
});

export const inspectSourceSchema = z.object({
  url: urlSchema,
});

export const createJobSchema = z.union([
  z.object({
    url: urlSchema,
    format: z.enum(['mp3', 'm4a']).default('mp3'),
    quality: z.enum(['standard', 'high']).default('high'),
  }),
  z.object({
    sourceUrl: urlSchema,
    format: z.enum(['mp3', 'm4a']).default('mp3'),
    quality: z.enum(['standard', 'high']).default('high'),
    items: z.array(sourceEntrySchema).min(1).max(200),
  }),
]);
