import { describe, expect, it } from 'vitest';

import { parseYtDlpProgressLine } from './progress.js';

describe('parseYtDlpProgressLine', () => {
  it('maps yt-dlp download percentages into app progress', () => {
    const parsed = parseYtDlpProgressLine('[download]  50.0% of 8.50MiB at 1.23MiB/s ETA 00:02');

    expect(parsed).toEqual({
      progress: 61,
      stage: 'Downloading source media',
    });
  });

  it('recognizes extraction stages', () => {
    expect(parseYtDlpProgressLine('[ExtractAudio] Destination: output.mp3')).toEqual({
      progress: 94,
      stage: 'Extracting audio',
    });
  });
});
