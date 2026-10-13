import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { IsoDate } from '../../../common/utils/clock';
import { moneyEventNote } from '../../bank-sync/domain/money-event-note';
import {
  matchByNote,
  type MatchResult,
  type MatchTarget,
} from '../domain/note-match';
import {
  MIN_PHRASE_LENGTH,
  normalizeNote,
  phraseMatches,
  phrasesOverlap,
} from '../domain/note-normalize';
import { CASHFLOW_EVENTS_REPOSITORY } from '../repositories/cashflow-events.repository.interface';
import type { CashflowEventsRepository } from '../repositories/cashflow-events.repository.interface';
import { PrismaSettlementRepository } from '../repositories/prisma-settlement.repository';

export interface BankNoteFacts {
  providerCode: string | null;
  description: string | null;
  direction: 'IN' | 'OUT';
  walletId: string;
  txDate: IsoDate;
}

const PREVIEW_DAYS = 30;

/** Note-rule CRUD and the ingest-time matcher. See memory/cashflow-settlement.md. */
@Injectable()
export class CashflowMatcherService {
  constructor(
    @Inject(CASHFLOW_EVENTS_REPOSITORY)
    private readonly cashflowEvents: CashflowEventsRepository,
    private readonly repo: PrismaSettlementRepository,
  ) {}

  async match(householdId: string, facts: BankNoteFacts): Promise<MatchResult> {
    const rules = await this.repo.listActiveRules(householdId);
    if (rules.length === 0) return { status: 'none', reason: 'NO_RULE' };

    const note = moneyEventNote(facts.providerCode, facts.description);
    const normalized = normalizeNote(note);
    const hitEventIds = [
      ...new Set(
        rules
          .filter((rule) => phraseMatches(normalized, rule.phraseNormalized))
          .map((rule) => rule.cashflowEventId),
      ),
    ];

    const targets = new Map<string, MatchTarget>();
    for (const eventId of hitEventIds) {
      const event = await this.cashflowEvents.findCashflowEventById(
        householdId,
        eventId,
      );
      if (!event) continue;
      const [latest] = await this.repo.listSettlements(eventId);
      targets.set(eventId, {
        event,
        latestManual:
          latest &&
          latest.settledVia === 'manual_complete' &&
          !latest.notificationEventId
            ? {
                moneyEventId: latest.moneyEventId,
                occurrenceDate: latest.occurrenceDate,
              }
            : null,
      });
    }

    return matchByNote({
      note,
      direction: facts.direction,
      walletId: facts.walletId,
      txDate: facts.txDate,
      rules,
      targets,
    });
  }

  listHouseholdRules(householdId: string) {
    return this.repo.listActiveRules(householdId);
  }

  async listRules(householdId: string, eventId: string) {
    await this.ensureEvent(householdId, eventId);
    return this.repo.listRules(householdId, eventId);
  }

  async createRule(
    householdId: string,
    eventId: string,
    phrase: string,
    actorId: string,
  ) {
    await this.ensureEvent(householdId, eventId);
    const trimmed = (phrase ?? '').trim();
    const normalized = normalizeNote(trimmed);
    if (normalized.length < MIN_PHRASE_LENGTH) {
      throw new BadRequestException(
        `phrase must be at least ${MIN_PHRASE_LENGTH} characters after normalisation`,
      );
    }
    const clash = (await this.repo.listActiveRules(householdId)).find(
      (rule) =>
        rule.cashflowEventId !== eventId &&
        phrasesOverlap(rule.phraseNormalized, normalized),
    );
    if (clash) {
      throw new ConflictException(
        `phrase overlaps a rule on cashflow event "${clash.cashflowEventId}"`,
      );
    }
    return this.repo.insertRule({
      householdId,
      cashflowEventId: eventId,
      phrase: trimmed,
      phraseNormalized: normalized,
      createdById: actorId,
    });
  }

  async deleteRule(householdId: string, eventId: string, ruleId: string) {
    await this.ensureEvent(householdId, eventId);
    if (!(await this.repo.deleteRule(householdId, ruleId))) {
      throw new NotFoundException(`Match rule "${ruleId}" was not found`);
    }
    return { deleted: true, ruleId };
  }

  /** Which recent bank notes a phrase would hit. */
  async previewRule(householdId: string, phrase: string) {
    const normalized = normalizeNote(phrase);
    const since = new Date(Date.now() - PREVIEW_DAYS * 86_400_000);
    const rows = await this.repo.recentBankNotes(householdId, since);
    return rows.map((row) => {
      const note = moneyEventNote(row.providerCode, row.description);
      return {
        bankEventId: row.id,
        note,
        receivedAt: row.receivedAt.toISOString(),
        matches: phraseMatches(normalizeNote(note), normalized),
      };
    });
  }

  private async ensureEvent(householdId: string, eventId: string) {
    const event = await this.cashflowEvents.findCashflowEventById(
      householdId,
      eventId,
    );
    if (!event) {
      throw new NotFoundException(`Cashflow event "${eventId}" was not found`);
    }
    return event;
  }
}
