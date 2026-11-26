import './loadEnv';
import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(5050),
  API_URL: z.string().url().default('http://localhost:5050'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  SUPABASE_URL: optional,
  SUPABASE_SERVICE_ROLE_KEY: optional,
  SUPABASE_BUCKET: z.string().default('products'),
  TELEGRAM_BOT_TOKEN: optional,
  TELEGRAM_BOT_USERNAME: z.string().default('hikmafashionbot'),
  TELEGRAM_WEBHOOK_SECRET: optional,
  /** Use long polling instead of a webhook (local development only). */
  TELEGRAM_POLLING: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Development only: enables POST /api/auth/dev (sign in as a test customer without Telegram). Ignored in production. */
  DEV_LOGIN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SHEGERPAY_API_KEY: optional,
  /** Passphrase that encrypts backups (≥16 chars). Keep a copy outside the server — without it a backup can't be opened. */
  BACKUP_KEY: optional,
  /** Where backups go (Telegram chat id). Default: the owner's connected Telegram. */
  BACKUP_CHAT_ID: optional,
  SHEGERPAY_BASE_URL: z.string().url().default('https://api.shegerpay.com/api/v1'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  // Trailing slashes are stripped: browsers send the Origin header without one
  clientOrigins: parsed.data.CLIENT_URL.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  /** First client origin; used when building links. */
  clientUrl: parsed.data.CLIENT_URL.split(',')[0]!.trim().replace(/\/+$/, ''),
  apiUrl: parsed.data.API_URL.replace(/\/+$/, ''),
};
