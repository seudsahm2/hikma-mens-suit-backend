import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile, unlink } from 'node:fs/promises';
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

/** Reads one stored object (backups). Null when it doesn't exist. */
export async function getObject(objectPath: string): Promise<Buffer | null> {
  if (supabase) {
    const { data, error } = await supabase.storage.from(env.SUPABASE_BUCKET).download(objectPath);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }
  return readFile(path.join(LOCAL_UPLOAD_DIR, objectPath)).catch(() => null);
}

/** Writes one object back at its exact path (restore). */
export const putObject = (objectPath: string, body: Buffer, contentType: string) => put(objectPath, body, contentType);

export const removeObjects = (objectPaths: string[]) => remove(objectPaths);

/** Every stored object with size and date (storage report / orphan cleanup). */
export async function listObjects(): Promise<{ path: string; size: number; updatedAt: Date }[]> {
  const out: { path: string; size: number; updatedAt: Date }[] = [];
  if (supabase) {
    const walk = async (prefix: string) => {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await supabase!.storage.from(env.SUPABASE_BUCKET).list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
        if (error) throw error;
        for (const o of data ?? []) {
          const p = prefix ? `${prefix}/${o.name}` : o.name;
          if (!o.id) await walk(p); // folder
          else out.push({ path: p, size: Number((o.metadata as { size?: number } | null)?.size ?? 0), updatedAt: new Date(o.updated_at ?? o.created_at ?? Date.now()) });
        }
        if ((data?.length ?? 0) < 1000) break;
      }
    };
    await walk('');
    return out;
  }
  const walk = async (dir: string, rel: string) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(full, r);
      else {
        const st = await stat(full);
        out.push({ path: r, size: st.size, updatedAt: st.mtime });
      }
    }
  };
  await walk(LOCAL_UPLOAD_DIR, '');
  return out;
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
export async function saveImage(input: Buffer, folder: 'products' | 'proofs' | 'site' | 'originals' | 'reviews') {
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

/** Restore: rebuilds the three sizes of an image at its ORIGINAL key (so every saved link keeps working). */
export async function writeImageAt(key: string, input: Buffer) {
  const base = sharp(input, { failOn: 'none' });
  await Promise.all(
    (Object.entries(IMAGE_SIZES) as [ImageSize, number][]).map(async ([size, width]) => {
      const buf = await base.clone().resize({ width, withoutEnlargement: true }).webp({ quality: size === 'sm' ? 72 : 80 }).toBuffer();
      await put(`${key}-${size}.webp`, buf, 'image/webp');
    }),
  );
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
