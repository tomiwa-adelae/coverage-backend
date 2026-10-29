import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Client, CurrentUser } from '../common/decorators';
import type { AuthUser, ClientInfo } from '../common/decorators';
import {
  BalanceBatchDto,
  BalanceDto,
  CreateProspectDto,
  ImportProspectsDto,
  ListProspectsQuery,
  LogActivityDto,
  ReferralAskedDto,
  MonthQuery,
  SendEmailDto,
  SendSmsDto,
  UpdateProspectDto,
} from './prospect.dto';
import { ProspectsService } from './prospects.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';

@Controller('prospects')
export class ProspectsController {
  constructor(
    private prospects: ProspectsService,
    private mail: MailService,
    private sms: SmsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: ListProspectsQuery) {
    return this.prospects.list(user.sub, query);
  }

  @Get('meta')
  async meta(@CurrentUser() user: AuthUser) {
    const [groups, areas, stageCounts] = await Promise.all([
      this.prospects.distinct(user.sub, 'group'),
      this.prospects.distinct(user.sub, 'area'),
      this.prospects.stageCounts(user.sub),
    ]);
    // Which "send from Coverage" channels are switched on, so the UI can offer them.
    const channels = { email: this.mail.configured, sms: this.sms.configured };
    return { groups, areas, stageCounts, channels };
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header(
    'Content-Disposition',
    'attachment; filename="coverage-prospects.csv"',
  )
  @Header('Cache-Control', 'no-store')
  export(@CurrentUser() user: AuthUser, @Client() client: ClientInfo) {
    return this.prospects.exportCsv(user.sub, client);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('import')
  import(
    @CurrentUser() user: AuthUser,
    @Body() dto: ImportProspectsDto,
    @Client() client: ClientInfo,
  ) {
    return this.prospects.import(user.sub, dto.rows, client);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.prospects.get(user.sub, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProspectDto) {
    return this.prospects.create(user.sub, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProspectDto,
  ) {
    return this.prospects.update(user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Client() client: ClientInfo,
  ) {
    return this.prospects.remove(user.sub, id, client);
  }

  @Post(':id/activities')
  log(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LogActivityDto,
  ) {
    return this.prospects.logActivity(user.sub, id, dto);
  }

  @Post(':id/referral-asked')
  @HttpCode(200)
  referralAsked(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReferralAskedDto,
  ) {
    return this.prospects.setReferralAsked(user.sub, id, dto.asked);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/email')
  sendEmail(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendEmailDto,
  ) {
    return this.prospects.sendEmail(user.sub, id, dto);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/sms')
  sendSms(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendSmsDto,
  ) {
    return this.prospects.sendSms(user.sub, id, dto);
  }

  @Put(':id/balances')
  setBalance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BalanceDto,
  ) {
    return this.prospects.setBalance(user.sub, id, dto);
  }

  @Delete(':id/balances/:month')
  removeBalance(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('month') month: string,
  ) {
    return this.prospects.removeBalance(user.sub, id, month);
  }

  @Delete(':id/activities/:activityId')
  @HttpCode(204)
  removeActivity(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('activityId', ParseUUIDPipe) activityId: string,
  ) {
    return this.prospects.deleteActivity(user.sub, id, activityId);
  }
}

/** Monthly balances across all customers. */
@Controller('balances')
export class BalancesController {
  constructor(private prospects: ProspectsService) {}

  @Get()
  sheet(@CurrentUser() user: AuthUser, @Query() query: MonthQuery) {
    return this.prospects.balanceSheet(user.sub, query.month);
  }

  @Put()
  save(@CurrentUser() user: AuthUser, @Body() dto: BalanceBatchDto) {
    return this.prospects.saveBalanceSheet(user.sub, dto);
  }
}
