import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.isProd ? 'info' : 'debug',
  redact: ['req.headers.authorization', 'req.headers.cookie'],
  ...(env.isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } } }),
});
