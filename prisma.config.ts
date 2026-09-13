import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

// Prisma 7 drops the package.json#prisma key; this replaces it. Unlike the old
// behaviour, a config file does NOT auto-load .env — the import above does.
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
});
