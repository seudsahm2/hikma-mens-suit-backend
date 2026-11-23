import { Router } from 'express';
import { env } from '../../config/env';
import { ah } from '../../lib/http';
import { getPublicConfig } from './settings.service';

export const settingsRouter = Router();

settingsRouter.get(
  '/',
  ah(async (_req, res) => {
    const config = await getPublicConfig();
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      ...config,
      telegram: { botUsername: env.TELEGRAM_BOT_USERNAME, miniAppShortName: env.TELEGRAM_MINIAPP_SHORT_NAME },
    });
  }),
);
