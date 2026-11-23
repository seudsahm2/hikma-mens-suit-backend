import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Images are resized once on upload into three WebP renditions:
 *   <key>-sm.webp (480px)  — grids, thumbnails
 *   <key>-md.webp (960px)  — product page on phones
 *   <key>-lg.webp (1600px) — zoom / desktop
 * Storage is Supabase Storage in production, local ./uploads in development.
 */
export const IMAGE_SIZES = { sm: 480, md: 960, lg: 1600 } as const;
export type ImageSize = keyof typeof IMAGE_SIZES;

export const LOCAL_UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

let supabase: SupabaseClient | null = null;
if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export const storageMode = supabase ? 'supabase' : 'local';

async function put(objectPath: string, body: Buffer, contentType: string) {
  if (supabase) {
    const { error } = await supabase.storage
      .from(env.SUPABASE_BUCKET)
      .upload(objectPath, body, { contentType, upsert: true, cacheControl: '31536000' });
    if (error) throw error;
    return;
  }
  const full = path.join(LOCAL_UPLOAD_DIR, objectPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
}

async function remove(objectPaths: string[]) {
  if (supabase) {
    const { error } = await supabase.storage.from(env.SUPABASE_BUCKET).remove(objectPaths);
    if (error) logger.warn({ error }, 'storage remove failed');
    return;
  }
  await Promise.all(objectPaths.map((p) => unlink(path.join(LOCAL_UPLOAD_DIR, p)).catch(() => undefined)));
}

export function publicUrl(objectPath: string): string {
  if (supabase) return `${env.SUPABASE_URL}/storage/v1/object/public/${env.SUPABASE_BUCKET}/${objectPath}`;
  return `${env.apiUrl}/uploads/${objectPath}`;
}

export function imageUrls(key: string): Record<ImageSize, string> {
  return {
    sm: publicUrl(`${key}-sm.webp`),
    md: publicUrl(`${key}-md.webp`),
    lg: publicUrl(`${key}-lg.webp`),
  };
}

/** Resizes and stores an image. Returns its key and original dimensions. */
export async function saveImage(input: Buffer, folder: 'products' | 'proofs' | 'site') {
  const key = `${folder}/${randomUUID()}`;
  const base = sharp(input, { failOn: 'none' }).rotate(); // honour EXIF orientation
  const meta = await base.metadata();
  await Promise.all(
    (Object.entries(IMAGE_SIZES) as [ImageSize, number][]).map(async ([size, width]) => {
      const buf = await base
        .clone()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: size === 'sm' ? 72 : 80 })
        .toBuffer();
      await put(`${key}-${size}.webp`, buf, 'image/webp');
    }),
  );
  return { key, width: meta.width ?? null, height: meta.height ?? null };
}

/** Stores a file as-is (used for the hero video). Returns its public URL. */
export async function saveRaw(input: Buffer, folder: 'site', ext: string, contentType: string) {
  const objectPath = `${folder}/${randomUUID()}.${ext}`;
  await put(objectPath, input, contentType);
  return publicUrl(objectPath);
}

export async function deleteImage(key: string) {
  await remove(Object.keys(IMAGE_SIZES).map((s) => `${key}-${s}.webp`));
}
