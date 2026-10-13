import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { PrismaRepository } from '../../../common/repositories/prisma.repository';
import type { IsoDate } from '../../../common/utils/clock';
import type { SettledVia, SettlementEvidence } from '../domain/settlement';
import type { MatchRuleView } from '../domain/note-match';

export interface SettlementMoneyEvent {
  id: string;
  householdId: string;
  amount: number;
  direction: string;
  eventDate: IsoDate;
  fromAssetId: string | null;
  toAssetId: string | null;
  cashflowEventId: string | null;
  occurrenceDate: IsoDate | null;
  settledVia: SettledVia | null;
  origin: string;
  notificationEventId: string | null;
  note: string;
}

export interface MarkSettled {
  cashflowEventId: string;
  occurrenceDate: IsoDate;
  settledVia: SettledVia;
  settledById: string | null;
  settledAt: Date;
  matchRuleId: string | null;
}

export interface MatchRule extends MatchRuleView {
  phrase: string;
  createdAt: string;
}

export interface LinkCandidate {
  kind: 'money_event' | 'bank_event';
  id: string;
  amount: number;
  date: IsoDate;
  assetId: string | null;
  note: string;
}

const isoDate = (value: Date | null): IsoDate | null =>
  value ? value.toISOString().slice(0, 10) : null;

const ME_SELECT = {
  id: true,
  householdId: true,
  amount: true,
  direction: true,
  eventDate: true,
  fromAssetId: true,
  toAssetId: true,
  cashflowEventId: true,
  occurrenceDate: true,
  settledVia: true,
  settledAt: true,
  settledById: true,
  origin: true,
  notificationEventId: true,
  description: true,
} satisfies Prisma.MoneyEventSelect;

type MeRow = Prisma.MoneyEventGetPayload<{ select: typeof ME_SELECT }>;

function mapMoneyEvent(row: MeRow): SettlementMoneyEvent {
  return {
    id: row.id,
    householdId: row.householdId,
    amount: Number(row.amount),
    direction: row.direction,
    eventDate: isoDate(row.eventDate)!,
    fromAssetId: row.fromAssetId,
    toAssetId: row.toAssetId,
    cashflowEventId: row.cashflowEventId,
    occurrenceDate: isoDate(row.occurrenceDate),
    settledVia: row.settledVia as SettledVia | null,
    origin: row.origin,
    notificationEventId: row.notificationEventId,
    note: row.description ?? '',
  };
}

@Injectable()
export class PrismaSettlementRepository extends PrismaRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async lockCashflowEvent(eventId: string): Promise<void> {
    await this.prisma
      .$queryRaw`SELECT id FROM cashflow_events WHERE id = ${eventId}::uuid FOR UPDATE`;
  }

  async lockMoneyEvent(
    householdId: string,
    moneyEventId: string,
  ): Promise<SettlementMoneyEvent | null> {
    await this.prisma
      .$queryRaw`SELECT id FROM money_events WHERE id = ${moneyEventId}::uuid FOR UPDATE`;
    const row = await this.prisma.moneyEvent.findFirst({
      where: { id: moneyEventId, householdId, deletedAt: null },
      select: ME_SELECT,
    });
    return row ? mapMoneyEvent(row) : null;
  }

  async findMoneyEvent(
    householdId: string,
    moneyEventId: string,
  ): Promise<SettlementMoneyEvent | null> {
    const row = await this.prisma.moneyEvent.findFirst({
      where: { id: moneyEventId, householdId, deletedAt: null },
      select: ME_SELECT,
    });
    return row ? mapMoneyEvent(row) : null;
  }

  /** Newest occurrence first. */
  async listSettlements(
    cashflowEventId: string,
  ): Promise<SettlementEvidence[]> {
    const rows = await this.prisma.moneyEvent.findMany({
      where: {
        cashflowEventId,
        deletedAt: null,
        occurrenceDate: { not: null },
      },
      orderBy: { occurrenceDate: 'desc' },
      select: ME_SELECT,
    });
    return rows.map((row) => ({
      moneyEventId: row.id,
      occurrenceDate: isoDate(row.occurrenceDate)!,
      amount: Number(row.amount),
      assetId: row.direction === 'inflow' ? row.toAssetId : row.fromAssetId,
      settledAt: (row.settledAt ?? row.eventDate).toISOString(),
      settledById: row.settledById,
      settledVia: (row.settledVia ?? 'manual_complete') as SettledVia,
      notificationEventId: row.notificationEventId,
    }));
  }

  async markSettled(moneyEventId: string, mark: MarkSettled): Promise<void> {
    await this.prisma.moneyEvent.update({
      where: { id: moneyEventId },
      data: {
        cashflowEventId: mark.cashflowEventId,
        occurrenceDate: new Date(`${mark.occurrenceDate}T00:00:00.000Z`),
        settledVia: mark.settledVia,
        settledById: mark.settledById,
        settledAt: mark.settledAt,
        matchRuleId: mark.matchRuleId,
      },
    });
  }

  async clearSettlement(moneyEventId: string): Promise<void> {
    await this.prisma.moneyEvent.update({
      where: { id: moneyEventId },
      data: {
        occurrenceDate: null,
        settledVia: null,
        settledById: null,
        settledAt: null,
        matchRuleId: null,
      },
    });
  }

  /** Bank money in the window that no occurrence has claimed, plus postable inbox rows. */
  async findLinkCandidates(
    householdId: string,
    direction: 'inflow' | 'outflow',
    since: IsoDate,
    query?: string,
  ): Promise<LinkCandidate[]> {
    const text = query?.trim() || undefined;
    const [moneyEvents, bankEvents] = await Promise.all([
      this.prisma.moneyEvent.findMany({
        where: {
          householdId,
          deletedAt: null,
          origin: 'bank_notification',
          cashflowEventId: null,
          direction,
          eventDate: { gte: new Date(`${since}T00:00:00.000Z`) },
          ...(text
            ? { description: { contains: text, mode: 'insensitive' } }
            : {}),
        },
        orderBy: { eventDate: 'desc' },
        take: 50,
        select: ME_SELECT,
      }),
      this.prisma.bankNotificationEvent.findMany({
        where: {
          householdId,
          status: { in: ['REVIEW', 'UNMAPPED', 'DUPLICATE'] },
          amountMinor: { not: null },
          direction: direction === 'inflow' ? 'IN' : 'OUT',
          receivedAt: { gte: new Date(`${since}T00:00:00.000Z`) },
          ...(text
            ? { description: { contains: text, mode: 'insensitive' } }
            : {}),
        },
        orderBy: { receivedAt: 'desc' },
        take: 50,
      }),
    ]);

    return [
      ...moneyEvents.map((row) => {
        const me = mapMoneyEvent(row);
        return {
          kind: 'money_event' as const,
          id: me.id,
          amount: me.amount,
          date: me.eventDate,
          assetId: me.direction === 'inflow' ? me.toAssetId : me.fromAssetId,
          note: me.note,
        };
      }),
      ...bankEvents.map((row) => ({
        kind: 'bank_event' as const,
        id: row.id,
        amount: Number(row.amountMinor),
        date: isoDate(
          row.transactionAt ?? row.notificationAt ?? row.receivedAt,
        )!,
        assetId: row.matchedAssetId,
        note: row.description ?? '',
      })),
    ];
  }

  async listRules(householdId: string, cashflowEventId: string) {
    const rows = await this.prisma.cashflowMatchRule.findMany({
      where: { householdId, cashflowEventId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(mapRule);
  }

  async listActiveRules(householdId: string): Promise<MatchRule[]> {
    const rows = await this.prisma.cashflowMatchRule.findMany({
      where: {
        householdId,
        deletedAt: null,
        isEnabled: true,
        cashflowEvent: { deletedAt: null },
      },
    });
    return rows.map(mapRule);
  }

  async insertRule(rule: {
    householdId: string;
    cashflowEventId: string;
    phrase: string;
    phraseNormalized: string;
    createdById: string;
  }): Promise<MatchRule> {
    const row = await this.prisma.cashflowMatchRule.create({ data: rule });
    return mapRule(row);
  }

  async deleteRule(householdId: string, ruleId: string): Promise<boolean> {
    const { count } = await this.prisma.cashflowMatchRule.updateMany({
      where: { id: ruleId, householdId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return count > 0;
  }

  /** Recent masked bank notes, for previewing a phrase. */
  async recentBankNotes(householdId: string, since: Date) {
    return this.prisma.bankNotificationEvent.findMany({
      where: {
        householdId,
        receivedAt: { gte: since },
        description: { not: null },
      },
      orderBy: { receivedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        providerCode: true,
        description: true,
        receivedAt: true,
      },
    });
  }
}

function mapRule(row: {
  id: string;
  cashflowEventId: string;
  phrase: string;
  phraseNormalized: string;
  createdAt: Date;
}): MatchRule {
  return {
    id: row.id,
    cashflowEventId: row.cashflowEventId,
    phrase: row.phrase,
    phraseNormalized: row.phraseNormalized,
    createdAt: row.createdAt.toISOString(),
  };
}
