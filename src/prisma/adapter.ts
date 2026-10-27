import { neonConfig } from '@neondatabase/serverless';
import { PrismaNeon } from '@prisma/adapter-neon';
import { PrismaPg } from '@prisma/adapter-pg';
import ws from 'ws';

// Required for Neon serverless in Node.js environment
neonConfig.webSocketConstructor = ws;

/** Neon's serverless driver for Neon URLs, plain pg for local Postgres. */
export function createAdapter(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return connectionString.includes('neon.tech')
    ? new PrismaNeon({ connectionString })
    : new PrismaPg({ connectionString });
}
