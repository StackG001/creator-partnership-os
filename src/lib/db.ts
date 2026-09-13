import { PrismaClient } from '@prisma/client';

/**
 * One Prisma client per process. Next dev reloads would otherwise open a new
 * connection pool on every hot reload, so the instance is stashed on globalThis.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/** CLI modules should call this before exiting so the process does not hang. */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
