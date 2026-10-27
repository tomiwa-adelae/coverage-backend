import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ClientInfo } from '../common/decorators';

/** Plain-English labels for the security log, keyed by action. */
export const AUDIT_ACTIONS = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in attempt',
  'auth.register': 'Created account',
  'auth.logout': 'Signed out',
  'auth.password_reset': 'Reset password from email link',
  'auth.password_changed': 'Changed password',
  'auth.2fa_enabled': 'Turned on two-step sign-in',
  'auth.2fa_disabled': 'Turned off two-step sign-in',
  'auth.backup_code_used': 'Signed in with a backup code',
  'session.revoked': 'Signed out a device',
  'session.revoked_all': 'Signed out all other devices',
  'prospect.deleted': 'Deleted a prospect',
  'prospects.imported': 'Imported prospects',
  'prospects.exported': 'Exported prospects',
  'calendar.reset': 'Reset calendar link',
  'team.joined': 'Joined a team',
  'team.left': 'Left a team',
} as const;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

@Injectable()
export class AuditService {
  private log = new Logger('Audit');

  constructor(private prisma: PrismaService) {}

  /** Never fails the request it describes; a lost log line is better than a lost save. */
  async record(
    userId: string,
    action: AuditAction,
    client?: ClientInfo,
    detail?: string,
  ) {
    await this.prisma.auditLog
      .create({
        data: {
          userId,
          action,
          detail,
          ip: client?.ip,
          userAgent: client?.userAgent?.slice(0, 300),
        },
      })
      .catch((e: Error) => this.log.error(e.message));
  }

  async list(userId: string) {
    const rows = await this.prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      label: AUDIT_ACTIONS[r.action as AuditAction] ?? r.action,
      detail: r.detail,
      ip: r.ip,
      userAgent: r.userAgent,
      createdAt: r.createdAt,
    }));
  }
}
