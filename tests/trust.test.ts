import { describe, expect, it } from 'vitest';
import { tikTokVideoId } from '../src/lib/tiktok';
import { mergeSizeProfile, readSizeProfile } from '../src/lib/sizeProfile';

describe('TikTok links', () => {
  it('reads the video id from full links', () => {
    expect(tikTokVideoId('https://www.tiktok.com/@hikutiiiiiiii/video/7412345678901234567?is_from_webapp=1')).toBe('7412345678901234567');
    expect(tikTokVideoId('https://m.tiktok.com/v/x?share_item_id=7412345678901234567')).toBe('7412345678901234567');
  });
  it('returns null for short links and other sites', () => {
    expect(tikTokVideoId('https://vm.tiktok.com/ZMabc123/')).toBeNull();
    expect(tikTokVideoId('https://youtube.com/watch?v=1')).toBeNull();
    expect(tikTokVideoId(null)).toBeNull();
  });
});

describe('size profile', () => {
  it('ignores junk and keeps valid values', () => {
    expect(readSizeProfile({ height: 500, weight: 80, fit: 'huge', sizes: { suits: '50', x: 5 } })).toEqual({
      height: undefined,
      weight: 80,
      fit: undefined,
      sizes: { suits: '50' },
    });
    expect(readSizeProfile(null)).toEqual({ height: undefined, weight: undefined, fit: undefined, sizes: {} });
  });
  it('merges sizes per category instead of replacing them', () => {
    const merged = mergeSizeProfile({ height: 180, sizes: { suits: '50' } }, { sizes: { jeans: '32' }, weight: 78 });
    expect(merged).toEqual({ height: 180, weight: 78, sizes: { suits: '50', jeans: '32' } });
  });
});
