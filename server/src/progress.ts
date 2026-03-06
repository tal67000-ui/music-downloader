export interface ParsedProgress {
  progress?: number;
  stage?: string;
}

const downloadRegex = /(\d+(?:\.\d+)?)%/;

export function parseYtDlpProgressLine(line: string): ParsedProgress | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('[download]')) {
    const match = trimmed.match(downloadRegex);
    if (!match) {
      return { stage: 'Downloading source media' };
    }

    const raw = Number(match[1]);
    const normalized = Math.min(92, Math.max(30, 30 + raw * 0.62));
    return {
      progress: Math.round(normalized),
      stage: raw >= 100 ? 'Finalizing audio' : 'Downloading source media',
    };
  }

  if (trimmed.includes('[ExtractAudio]')) {
    return { progress: 94, stage: 'Extracting audio' };
  }

  if (trimmed.includes('Destination:')) {
    return { progress: 96, stage: 'Writing output file' };
  }

  if (trimmed.includes('Deleting original file')) {
    return { progress: 98, stage: 'Cleaning temporary files' };
  }

  return null;
}
