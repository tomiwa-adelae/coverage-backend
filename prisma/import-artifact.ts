// Imports prospects exported from the Prospect Desk artifact into a Coverage account.
// Usage: pnpm import:artifact you@example.com [path/to/prospects.json]
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { ActivityType, PrismaClient, Stage, Tier } from '@prisma/client';
import { createAdapter } from '../src/prisma/adapter';

interface ArtifactProspect {
  name: string;
  company?: string;
  group?: string;
  phone?: string;
  email?: string;
  tier?: string;
  stage?: string;
  potential?: number | string;
  funded?: number | string;
  nextAction?: string;
  nextDate?: string;
  notes?: string;
  created?: string;
  log?: { d: string; type: string; note?: string }[];
}

const STAGES: Record<string, Stage> = {
  Identified: Stage.IDENTIFIED,
  Contacted: Stage.CONTACTED,
  Interested: Stage.INTERESTED,
  'Forms sent': Stage.FORMS_SENT,
  'Forms received': Stage.FORMS_RECEIVED,
  'Account opened': Stage.ACCOUNT_OPENED,
  Funded: Stage.FUNDED,
  Declined: Stage.DECLINED,
};

const TOUCHES: Record<string, ActivityType> = {
  Call: ActivityType.CALL,
  WhatsApp: ActivityType.WHATSAPP,
  Visit: ActivityType.VISIT,
  Meeting: ActivityType.MEETING,
  Email: ActivityType.EMAIL,
  SMS: ActivityType.SMS,
};

const text = (v?: string) => v?.trim() || null;
const money = (v?: number | string) => {
  const n = String(v ?? '').replace(/[^\d]/g, '');
  return n ? BigInt(n) : null;
};

async function main() {
  const [email, file = path.join(__dirname, 'import', 'prospects.json')] =
    process.argv.slice(2);
  if (!email)
    throw new Error('Usage: pnpm import:artifact <your-email> [file]');

  const prisma = new PrismaClient({
    adapter: createAdapter(),
  });

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });
  if (!user)
    throw new Error(`No user with email ${email}. Sign up in the app first.`);

  const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as ArtifactProspect[];
  const existing = new Set(
    (
      await prisma.prospect.findMany({
        where: { ownerId: user.id },
        select: { name: true },
      })
    ).map((p) => p.name.toLowerCase()),
  );

  let created = 0;
  for (const r of rows) {
    if (!r.name?.trim() || existing.has(r.name.trim().toLowerCase())) continue;
    const log = (r.log ?? []).filter((l) => TOUCHES[l.type]);
    await prisma.prospect.create({
      data: {
        ownerId: user.id,
        name: r.name.trim(),
        company: text(r.company),
        group: text(r.group),
        phone: text(r.phone),
        email: text(r.email),
        tier: r.tier && r.tier in Tier ? (r.tier as Tier) : null,
        stage: STAGES[r.stage ?? ''] ?? Stage.IDENTIFIED,
        potential: money(r.potential),
        funded: money(r.funded),
        nextAction: text(r.nextAction),
        nextDate: r.nextDate ? new Date(`${r.nextDate}T00:00:00Z`) : null,
        notes: text(r.notes),
        createdAt: r.created ? new Date(r.created) : undefined,
        lastContactAt: log[0] ? new Date(`${log[0].d}T12:00:00Z`) : null,
        activities: {
          create: log.map((l) => ({
            userId: user.id,
            type: TOUCHES[l.type],
            note: text(l.note),
            occurredAt: new Date(`${l.d}T12:00:00Z`),
          })),
        },
      },
    });
    created++;
  }

  console.log(
    `Imported ${created} prospects for ${user.email} (${rows.length - created} skipped as duplicates or blank).`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
