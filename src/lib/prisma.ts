// Load the project env file (respecting ENV_FILE) BEFORE Prisma reads DATABASE_URL.
// Without this, any script that imports the database without importing config first would fall back
// to Prisma's own `.env` loading — which ignores ENV_FILE and could point at the production database.
import '../config/loadEnv';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
