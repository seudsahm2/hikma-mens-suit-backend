import path from 'node:path';
import { InputFile } from 'grammy';
import { imageUrls, LOCAL_UPLOAD_DIR, storageMode, type ImageSize } from '../../lib/storage';

/**
 * Telegram must be able to fetch photo URLs itself. In local development images live on
 * localhost, so they are uploaded as files instead.
 */
export function telegramPhoto(key: string, size: ImageSize = 'lg'): string | InputFile {
  if (storageMode === 'local') return new InputFile(path.join(LOCAL_UPLOAD_DIR, `${key}-${size}.webp`));
  return imageUrls(key)[size];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const birr = (n: number) => `${n.toLocaleString('en-US')} ETB`;
