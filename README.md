# hikma-mens-suit-backend

API and Telegram bot for Hikma Men's Fashion. Express · TypeScript · Prisma (PostgreSQL) · grammY · sharp + Supabase Storage.

See the [root README](../README.md) for setup and deployment.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API with reload on http://localhost:5050 |
| `npm run build` / `npm start` | Production build / start |
| `npm test` | Unit tests (Telegram signature checks, caption templates, import parser) |
| `npm run db:migrate` | Create a migration after changing `prisma/schema.prisma` |
| `npm run db:seed [-- --demo \| --clear-demo]` | Store configuration (+ demo products) |
| `npm run owner:create` | Create or reset the single owner account |
| `npm run import:telegram [-- --dry-run]` | Import the channel export as draft products |
| `npm run bot:setup` | Webhook, menu button, commands, descriptions |

## Layout

```
src/
  config/env.ts            validated environment
  lib/                     prisma, logger, auth tokens, image storage, helpers
  middleware/              auth (customer / staff / owner), validation, uploads, errors
  modules/
    auth/                  Telegram Mini App + Login Widget, staff login
    catalog/               categories, products, filters (public)
    orders/                checkout, payment proof, status changes, stock
    payments/              ShegerPay receipt verification (optional)
    settings/              public store configuration
    admin/                 products, orders, customers, staff, settings, analytics
    telegram/              bot, notifications, channel publishing, captions
  scripts/                 owner, bot setup, Telegram import, dev token
prisma/                    schema, migrations, seed data
```

## Local Telegram testing
Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_POLLING=true` to receive bot updates without a public URL. Don't run polling while the production webhook is set on the same bot: polling removes the webhook. Run `npm run bot:setup` again afterwards.
