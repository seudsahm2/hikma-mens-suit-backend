/**
 * Database snapshot → one gzip'd NDJSON file.
 *
 * Every table is read inside ONE repeatable-read transaction, so the snapshot is a single moment:
 * an order and its items, stock and stock movements always match (no half-finished checkout).
 *
 *   line 1      {"type":"header","format":"hikma-backup/1","createdAt":…,"migration":…,"models":[…]}
 *   lines …     {"t":"Order","r":{…row…}}            (values tagged by codec.ts)
 *   last line   {"type":"footer","counts":{…},"sha256":{…}}   (per table: row count + checksum)
 *
 * Tables are written in dependency order (parents first), which is also the order a restore inserts.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { encodeRow } from './codec';
import { sha256 } from './crypto';

export const FORMAT = 'hikma-backup/1';
const PAGE = 1000;

type Model = (typeof Prisma.dmmf.datamodel.models)[number];

/** Parents before children (a row's foreign keys always point to rows already inserted). */
export function modelsInOrder(): Model[] {
  const models = [...Prisma.dmmf.datamodel.models];
  const deps = new Map(
    models.map((m) => [
      m.name,
      new Set(m.fields.filter((f) => f.kind === 'object' && f.relationFromFields?.length && f.type !== m.name).map((f) => f.type)),
    ]),
  );
  const out: Model[] = [];
  const done = new Set<string>();
  while (out.length < models.length) {
    const ready = models.filter((m) => !done.has(m.name) && [...deps.get(m.name)!].every((d) => done.has(d)));
    if (!ready.length) throw new Error('Circular relations between tables — backup order needs a manual rule');
    for (const m of ready.sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(m);
      done.add(m.name);
    }
  }
  return out;
}

export const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

/** Primary key columns (single @id or composite @@id) — used to page in a stable order. */
export function keyFields(m: Model): string[] {
  const single = m.fields.find((f) => f.isId);
  return single ? [single.name] : [...(m.primaryKey?.fields ?? [])];
}

/** Every applied migration (sorted). Two databases with the same list have the same tables and columns. */
export async function appliedMigrations(client: Pick<typeof prisma, '$queryRawUnsafe'> = prisma) {
  const rows = await client.$queryRawUnsafe<{ migration_name: string }[]>(
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
  );
  return rows.map((r) => r.migration_name);
}

export interface Snapshot {
  gz: Buffer;
  createdAt: string;
  migration: string | null;
  rows: number;
  counts: Record<string, number>;
  sha256: string;
}

export async function createSnapshot(): Promise<Snapshot> {
  const models = modelsInOrder();
  const createdAt = new Date().toISOString();
  return prisma.$transaction(
    async (tx) => {
      const migrations = await appliedMigrations(tx);
      const migration = migrations.at(-1) ?? null;
      const lines: string[] = [JSON.stringify({ type: 'header', format: FORMAT, createdAt, migration, migrations, models: models.map((m) => m.name) })];
      const counts: Record<string, number> = {};
      const sums: Record<string, string> = {};
      for (const m of models) {
        const delegate = (tx as unknown as Record<string, { findMany: (a: object) => Promise<Record<string, unknown>[]> }>)[delegateName(m.name)]!;
        const orderBy = keyFields(m).map((k) => ({ [k]: 'asc' as const }));
        const hash = createHash('sha256');
        let n = 0;
        for (let skip = 0; ; skip += PAGE) {
          const rows = await delegate.findMany({ orderBy, skip, take: PAGE });
          for (const r of rows) {
            const line = JSON.stringify({ t: m.name, r: encodeRow(r) });
            hash.update(line);
            lines.push(line);
          }
          n += rows.length;
          if (rows.length < PAGE) break;
        }
        counts[m.name] = n;
        sums[m.name] = hash.digest('hex');
      }
      lines.push(JSON.stringify({ type: 'footer', counts, sha256: sums }));
      const gz = gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), { level: 9 });
      return { gz, createdAt, migration, rows: Object.values(counts).reduce((a, b) => a + b, 0), counts, sha256: sha256(gz) };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10 * 60_000, maxWait: 15_000 },
  );
}
