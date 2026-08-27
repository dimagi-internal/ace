import { describe, it, expect } from 'vitest';
import {
  ASSET_BUDGET_BYTES,
  TARGET_LONGEST_EDGE,
  base64Length,
  planPreparation,
  pickResizer,
  resizeArgv,
  jpegArgv,
  jpegQualityToFfmpegScale,
} from './media-prepare.js';

describe('base64Length', () => {
  it('computes the exact encoded length, padding included', () => {
    expect(base64Length(3)).toBe(4);
    expect(base64Length(1)).toBe(4);
    expect(base64Length(1_200_000)).toBe(1_600_000);
  });
});

describe('planPreparation', () => {
  it('passes through a file already inside the asset budget', () => {
    const p = planPreparation({ bytes: 40_000, kind: 'image' });
    expect(p.action).toBe('pass_through');
  });

  it('resizes an oversized image toward the device-appropriate edge', () => {
    const p = planPreparation({ bytes: 3_000_000, kind: 'image' });
    expect(p.action).toBe('resize');
    if (p.action !== 'resize') throw new Error('unreachable');
    expect(p.longestEdge).toBe(TARGET_LONGEST_EDGE);
  });

  it('resizes a file that fits on disk but whose base64 would not', () => {
    // Just under the budget in bytes, but 4/3 larger once encoded.
    const bytes = ASSET_BUDGET_BYTES - 1;
    const p = planPreparation({ bytes, kind: 'image', budgetBytes: ASSET_BUDGET_BYTES });
    expect(p.action).toBe('pass_through');
    const p2 = planPreparation({ bytes: bytes + 2, kind: 'image', budgetBytes: ASSET_BUDGET_BYTES });
    expect(p2.action).toBe('resize');
  });

  it('refuses an oversized audio or video file rather than silently truncating it', () => {
    for (const kind of ['audio', 'video'] as const) {
      const p = planPreparation({ bytes: 8_000_000, kind });
      expect(p.action).toBe('refuse');
      if (p.action !== 'refuse') throw new Error('unreachable');
      expect(p.reason).toMatch(/cannot be resized|re-encode/i);
    }
  });

  it('passes through small audio untouched', () => {
    expect(planPreparation({ bytes: 90_000, kind: 'audio' }).action).toBe('pass_through');
  });

  it('honours an explicitly supplied budget', () => {
    expect(planPreparation({ bytes: 5_000, kind: 'image', budgetBytes: 1_000 }).action).toBe(
      'resize',
    );
  });
});

describe('pickResizer', () => {
  it('prefers sips, then magick, then convert, then ffmpeg', () => {
    expect(pickResizer(['ffmpeg', 'convert', 'magick', 'sips'])).toBe('sips');
    expect(pickResizer(['ffmpeg', 'convert', 'magick'])).toBe('magick');
    expect(pickResizer(['ffmpeg', 'convert'])).toBe('convert');
    expect(pickResizer(['ffmpeg'])).toBe('ffmpeg');
  });

  it('returns null when no resizer is installed', () => {
    expect(pickResizer([])).toBeNull();
  });

  it('ignores tools it does not know how to drive', () => {
    expect(pickResizer(['photoshop'])).toBeNull();
  });
});

describe('jpegArgv / jpegQualityToFfmpegScale', () => {
  it('builds a JPEG re-encode for every supported resizer', () => {
    for (const tool of ['sips', 'magick', 'convert', 'ffmpeg'] as const) {
      const argv = jpegArgv(tool, '/in.png', '/out.jpg', 82);
      expect(argv[0]).toBe(tool);
      expect(argv).toContain('/out.jpg');
    }
  });

  it('passes the quality through directly for sips and ImageMagick', () => {
    expect(jpegArgv('sips', '/in.png', '/out.jpg', 82)).toContain('82');
    expect(jpegArgv('magick', '/in.png', '/out.jpg', 82)).toContain('82');
  });

  it('inverts quality onto ffmpeg’s 2-31 scale, where lower is better', () => {
    expect(jpegQualityToFfmpegScale(100)).toBe(2);
    expect(jpegQualityToFfmpegScale(0)).toBe(31);
    expect(jpegQualityToFfmpegScale(82)).toBeLessThan(jpegQualityToFfmpegScale(50));
  });

  it('clamps out-of-range quality rather than emitting a nonsense scale', () => {
    expect(jpegQualityToFfmpegScale(500)).toBe(2);
    expect(jpegQualityToFfmpegScale(-10)).toBe(31);
  });
});

describe('resizeArgv', () => {
  it('builds a sips invocation that bounds the longest edge', () => {
    const argv = resizeArgv('sips', '/in.png', '/out.png', 800);
    expect(argv[0]).toBe('sips');
    expect(argv).toContain('--resampleHeightWidthMax');
    expect(argv).toContain('800');
    expect(argv).toContain('/in.png');
    expect(argv[argv.length - 1]).toBe('/out.png');
  });

  it('builds an ImageMagick invocation that only shrinks, never upscales', () => {
    for (const tool of ['magick', 'convert'] as const) {
      const argv = resizeArgv(tool, '/in.png', '/out.png', 800);
      expect(argv[0]).toBe(tool);
      // The trailing `>` is ImageMagick's shrink-only geometry flag.
      expect(argv.join(' ')).toContain('800x800>');
    }
  });

  it('builds an ffmpeg invocation that preserves aspect ratio', () => {
    const argv = resizeArgv('ffmpeg', '/in.png', '/out.png', 800);
    expect(argv[0]).toBe('ffmpeg');
    expect(argv.join(' ')).toMatch(/scale=/);
    expect(argv.join(' ')).toContain('800');
  });

  it('never emits a shell string — argv form keeps a spaced path safe', () => {
    const argv = resizeArgv('sips', '/tmp/my photo.png', '/tmp/out.png', 800);
    expect(argv).toContain('/tmp/my photo.png');
    expect(argv.every((a) => typeof a === 'string')).toBe(true);
  });
});
