import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../../lib/http';
import { logger } from '../../lib/logger';
import { limiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';

/**
 * Turns a shared GPS location into a readable place ("Bole Medhanealem, Bole, Addis Ababa") so the
 * customer sees what was shared and the address fields fill in. Uses OpenStreetMap Nominatim through
 * our server (the customer's IP isn't sent to a third party), with a small cache.
 */
export const geoRouter = Router();

interface Place {
  label: string;
  area: string | null;
  landmark: string | null;
  city: string | null;
}

const cache = new Map<string, { at: number; place: Place | null }>();
const CACHE_MS = 24 * 3600 * 1000;

const query = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

geoRouter.get(
  '/reverse',
  limiter({ windowMs: 60 * 1000, limit: 20 }),
  validate(query, 'query'),
  ah(async (req, res) => {
    const { lat, lng } = req.query as unknown as z.infer<typeof query>;
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`; // ~11 m
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json({ place: hit.place });

    let place: Place | null = null;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=en&lat=${lat}&lon=${lng}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'HikmaShop/1.0 (store checkout address lookup)' }, signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = (await r.json()) as { name?: string; address?: Record<string, string> };
        const a = j.address ?? {};
        const area = a.suburb || a.city_district || a.neighbourhood || a.quarter || a.village || null;
        const landmark = j.name || a.amenity || a.shop || a.building || a.road || null;
        const city = a.city || a.town || a.state || null;
        const parts = [landmark, area, city].filter((p, i, arr): p is string => Boolean(p) && arr.indexOf(p) === i);
        place = parts.length ? { label: parts.join(', '), area, landmark, city } : null;
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'reverse geocoding failed');
    }
    cache.set(key, { at: Date.now(), place });
    if (cache.size > 5000) cache.delete(cache.keys().next().value!);
    res.json({ place });
  }),
);
