/** Owner only: backups (status, back up now) and storage (report, cleanup preview → apply). */
import { Router } from 'express';
import { ah } from '../../lib/http';
import { requireOwner, requireStaff } from '../../middleware/auth';
import { backupStatus, cleanupApply, cleanupPreview, runDbBackup, runFileBackup, storageReport } from './backup.service';

export const backupRouter = Router();
// Owner check on each route (a router-wide use() would also block other admin pages mounted on /api/admin)
const owner = [requireStaff, requireOwner];

backupRouter.get(
  '/backups',
  ...owner,
  ah(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await backupStatus());
  }),
);

backupRouter.post(
  '/backups/run',
  ...owner,
  ah(async (_req, res) => {
    const run = await runDbBackup('manual');
    res.json({ run: { ...run, messages: undefined } });
  }),
);

backupRouter.post(
  '/backups/files',
  ...owner,
  ah(async (_req, res) => {
    res.json({ copied: await runFileBackup(40, 'manual') });
  }),
);

backupRouter.get(
  '/storage',
  ...owner,
  ah(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await storageReport());
  }),
);

backupRouter.get(
  '/storage/cleanup',
  ...owner,
  ah(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await cleanupPreview());
  }),
);

backupRouter.post(
  '/storage/cleanup',
  ...owner,
  ah(async (req, res) => {
    res.json(await cleanupApply(req.user!.id));
  }),
);
