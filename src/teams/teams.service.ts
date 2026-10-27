import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActivityType, TeamRole } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { AuditService } from '../audit/audit.service';
import type { ClientInfo } from '../common/decorators';
import { addDays, startOfDay, todayIn, weekStart } from '../common/dates';

// No 0/O, 1/I/L: codes are read out loud and typed on phones.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () =>
  Array.from(
    { length: 8 },
    () => CODE_CHARS[randomInt(CODE_CHARS.length)],
  ).join('');

@Injectable()
export class TeamsService {
  constructor(
    private prisma: PrismaService,
    private dashboard: DashboardService,
    private audit: AuditService,
  ) {}

  /**
   * The team and each member's headline numbers. Everyone sees the leaderboard;
   * only managers see the invite code. Nobody sees another member's prospects.
   */
  async mine(userId: string) {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { team: { include: { members: true } } },
    });
    if (!me.team) return null;
    const manager = me.teamRole === TeamRole.MANAGER;

    const members = await Promise.all(
      me.team.members.map(async (m) => {
        const t = await this.dashboard.target(m.id);
        const today = todayIn(m.timezone);
        const monday = weekStart(today);
        const [contacts, opened] = await Promise.all([
          this.prisma.activity.count({
            where: {
              userId: m.id,
              type: { not: ActivityType.STAGE_CHANGE },
              occurredAt: { gte: startOfDay(monday, m.timezone) },
            },
          }),
          this.prisma.activity.count({
            where: {
              userId: m.id,
              type: ActivityType.STAGE_CHANGE,
              toStage: 'ACCOUNT_OPENED',
              occurredAt: {
                gte: startOfDay(addDays(today, -29), m.timezone),
              },
            },
          }),
        ]);
        return {
          id: m.id,
          name: m.name,
          jobTitle: m.jobTitle,
          branch: m.branch,
          avatarUrl: m.avatarUrl,
          role: m.teamRole,
          isMe: m.id === userId,
          balance: t.current,
          target: t.target,
          progress: t.target ? t.current / t.target : 0,
          projected: t.projected,
          onPace: t.onPace,
          weightedPipeline: t.forecast.weighted,
          contactsThisWeek: contacts,
          accountsOpened30d: opened,
        };
      }),
    );
    members.sort((a, b) => b.progress - a.progress || b.balance - a.balance);

    return {
      id: me.team.id,
      name: me.team.name,
      role: me.teamRole,
      inviteCode: manager ? me.team.inviteCode : null,
      totals: {
        balance: members.reduce((a, m) => a + m.balance, 0),
        target: members.reduce((a, m) => a + m.target, 0),
        contactsThisWeek: members.reduce((a, m) => a + m.contactsThisWeek, 0),
        weightedPipeline: members.reduce((a, m) => a + m.weightedPipeline, 0),
      },
      members,
    };
  }

  async create(userId: string, name: string) {
    await this.ensureNoTeam(userId);
    const team = await this.prisma.team.create({
      data: { name, inviteCode: newCode() },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { teamId: team.id, teamRole: TeamRole.MANAGER },
    });
    return this.mine(userId);
  }

  async join(userId: string, code: string, client: ClientInfo) {
    await this.ensureNoTeam(userId);
    const team = await this.prisma.team.findUnique({
      where: { inviteCode: code },
    });
    if (!team)
      throw new NotFoundException({
        statusCode: 404,
        message: 'No team uses that invite code. Check it with your manager.',
        errors: { code: 'No team uses that code' },
      });
    await this.prisma.user.update({
      where: { id: userId },
      data: { teamId: team.id, teamRole: TeamRole.MEMBER },
    });
    await this.audit.record(userId, 'team.joined', client, team.name);
    return this.mine(userId);
  }

  /** A departing manager hands over to the longest-standing member; the last one out closes the team. */
  async leave(userId: string, client: ClientInfo) {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { team: true },
    });
    if (!me.team) throw new BadRequestException('You’re not in a team.');
    await this.prisma.user.update({
      where: { id: userId },
      data: { teamId: null, teamRole: null },
    });
    const rest = await this.prisma.user.findMany({
      where: { teamId: me.team.id },
      orderBy: { createdAt: 'asc' },
    });
    if (!rest.length)
      await this.prisma.team.delete({ where: { id: me.team.id } });
    else if (
      me.teamRole === TeamRole.MANAGER &&
      !rest.some((u) => u.teamRole === TeamRole.MANAGER)
    )
      await this.prisma.user.update({
        where: { id: rest[0].id },
        data: { teamRole: TeamRole.MANAGER },
      });
    await this.audit.record(userId, 'team.left', client, me.team.name);
  }

  async newInviteCode(userId: string) {
    const me = await this.requireManager(userId);
    await this.prisma.team.update({
      where: { id: me.teamId! },
      data: { inviteCode: newCode() },
    });
    return this.mine(userId);
  }

  async removeMember(userId: string, memberId: string) {
    const me = await this.requireManager(userId);
    if (memberId === userId)
      throw new BadRequestException('Use “Leave team” to remove yourself.');
    const { count } = await this.prisma.user.updateMany({
      where: { id: memberId, teamId: me.teamId },
      data: { teamId: null, teamRole: null },
    });
    if (!count) throw new NotFoundException('That person isn’t in your team.');
    return this.mine(userId);
  }

  async rename(userId: string, name: string) {
    const me = await this.requireManager(userId);
    await this.prisma.team.update({
      where: { id: me.teamId! },
      data: { name },
    });
    return this.mine(userId);
  }

  private async ensureNoTeam(userId: string) {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (me.teamId)
      throw new BadRequestException(
        'You’re already in a team. Leave it first to join another.',
      );
  }

  private async requireManager(userId: string) {
    const me = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!me.teamId) throw new BadRequestException('You’re not in a team.');
    if (me.teamRole !== TeamRole.MANAGER)
      throw new ForbiddenException('Only the team manager can do that.');
    return me;
  }
}
