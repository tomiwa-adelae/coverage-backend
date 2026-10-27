import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createAdapter } from './adapter';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super({
      adapter: createAdapter(),
      log: ['error', 'warn'],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }
}
