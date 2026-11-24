import dotenv from 'dotenv';

/**
 * Loads this project's env file and lets it WIN over variables already set in the machine's environment.
 * (By default dotenv never overrides — so a TELEGRAM_BOT_TOKEN left in Windows by another project would
 * silently replace ours.) On Render there is no .env file, so the dashboard values are used as-is.
 *
 * ENV_FILE picks a different file, e.g. ENV_FILE=.env.localdev for the local database.
 */
dotenv.config({ path: process.env.ENV_FILE || '.env', override: true, quiet: true });
