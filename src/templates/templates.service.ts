import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TemplateDto, UpdateTemplateDto } from './template.dto';

/** Starter set, created once per user. Placeholders are filled in on the client. */
const DEFAULTS: { name: string; body: string }[] = [
  {
    name: 'Introduction',
    body: "Hello {firstName}, this is {myName}. I recently joined ProvidusUnity Bank and I'd love to tell you about our accounts for individuals and businesses. Can I give you a quick call this week?",
  },
  {
    name: 'Business introduction',
    body: "Good day {firstName}, I'm {myName} from ProvidusUnity Bank. We help businesses like {company} with collections, payroll and trade services. Could we schedule a short meeting at your convenience?",
  },
  {
    name: 'Account opening forms',
    body: "Hi {firstName}, as promised, here are the account opening forms. You'll need a valid ID, a recent utility bill, a passport photograph and your BVN. Send them back whenever you're ready, or I can come and pick them up.",
  },
  {
    name: 'Follow-up',
    body: "Hi {firstName}, just following up on our last conversation. Is this a good week to get your account set up? I'm happy to help with anything you need.",
  },
  {
    name: 'Thank you',
    body: 'Thank you for banking with us, {firstName}! Your account is all set. Please save my number and reach me directly whenever you need anything.',
  },
];

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  async list(ownerId: string) {
    await this.seedOnce(ownerId);
    return this.prisma.template.findMany({
      where: { ownerId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(ownerId: string, dto: TemplateDto) {
    const last = await this.prisma.template.findFirst({
      where: { ownerId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return this.prisma.template.create({
      data: {
        ownerId,
        name: dto.name.trim(),
        body: dto.body.trim(),
        position: (last?.position ?? -1) + 1,
      },
    });
  }

  async update(ownerId: string, id: string, dto: UpdateTemplateDto) {
    await this.owned(ownerId, id);
    return this.prisma.template.update({
      where: { id },
      data: { name: dto.name?.trim(), body: dto.body?.trim() },
    });
  }

  async remove(ownerId: string, id: string) {
    await this.owned(ownerId, id);
    await this.prisma.template.delete({ where: { id } });
  }

  private async seedOnce(ownerId: string) {
    // The conditional update claims the seed, so parallel first loads can't double it.
    const { count } = await this.prisma.user.updateMany({
      where: { id: ownerId, templatesSeeded: false },
      data: { templatesSeeded: true },
    });
    if (!count) return;
    await this.prisma.template.createMany({
      data: DEFAULTS.map((t, position) => ({ ...t, ownerId, position })),
    });
  }

  private async owned(ownerId: string, id: string) {
    const t = await this.prisma.template.findFirst({ where: { id, ownerId } });
    if (!t) throw new NotFoundException('Template not found');
    return t;
  }
}
