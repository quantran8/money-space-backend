import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  BankCredential,
  BankIngestContext,
} from '../entities/bank-sync.entity';
import {
  generateIngestToken,
  hashIngestToken,
  isIngestTokenShape,
} from '../domain/ingest-token';
import { BANK_SYNC_REPOSITORY } from '../repositories/bank-sync.repository.interface';
import type { BankSyncRepository } from '../repositories/bank-sync.repository.interface';

const LABEL_MAX = 60;
const MAX_ACTIVE_PER_USER = 10;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export interface CredentialView {
  id: string;
  deviceLabel: string;
  tokenPrefix: string | null;
  status: BankCredential['status'];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

@Injectable()
export class BankCredentialsService {
  constructor(
    @Inject(BANK_SYNC_REPOSITORY)
    private readonly repo: BankSyncRepository,
  ) {}

  /** The raw token is in this response and nowhere else, ever. */
  async create(
    householdId: string,
    userId: string,
    payload: { deviceLabel?: unknown },
  ) {
    const deviceLabel =
      typeof payload.deviceLabel === 'string' ? payload.deviceLabel.trim() : '';
    if (!deviceLabel || deviceLabel.length > LABEL_MAX) {
      throw new BadRequestException(
        `deviceLabel must be 1–${LABEL_MAX} characters.`,
      );
    }

    const existing = await this.repo.listCredentials(householdId, userId);
    if (
      existing.filter((c) => c.status === 'ACTIVE').length >=
      MAX_ACTIVE_PER_USER
    ) {
      throw new BadRequestException(
        'Too many active devices; revoke one first.',
      );
    }

    const { token, hash, prefix } = generateIngestToken();
    const credential: BankCredential = {
      id: this.repo.createId(),
      userId,
      householdId,
      deviceLabel,
      tokenPrefix: prefix,
      status: 'ACTIVE',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
      revokedAt: null,
    };
    await this.repo.insertCredential({ ...credential, tokenHash: hash });
    return { credential: toView(credential), token };
  }

  async list(householdId: string, userId: string) {
    const items = await this.repo.listCredentials(householdId, userId);
    return { items: items.map(toView) };
  }

  async revoke(householdId: string, userId: string, id: string) {
    const revoked = await this.repo.revokeCredential(
      householdId,
      userId,
      id,
      new Date(),
    );
    if (!revoked) {
      throw new NotFoundException('Active credential not found.');
    }
    return { revoked: true as const };
  }

  /** Token → owner, or null. Re-checks membership on every call. */
  async authenticate(
    token: string,
    now = new Date(),
  ): Promise<BankIngestContext | null> {
    if (!isIngestTokenShape(token)) return null;
    const credential = await this.repo.findCredentialByHash(
      hashIngestToken(token),
    );
    if (!credential || credential.status !== 'ACTIVE') return null;
    if (credential.expiresAt && credential.expiresAt <= now) return null;
    if (
      !(await this.repo.isLiveMember(credential.householdId, credential.userId))
    ) {
      return null;
    }
    if (
      !credential.lastUsedAt ||
      now.getTime() - credential.lastUsedAt.getTime() > TOUCH_EVERY_MS
    ) {
      await this.repo.touchCredential(credential.id, now);
    }
    return {
      credentialId: credential.id,
      userId: credential.userId,
      householdId: credential.householdId,
    };
  }
}

function toView(c: BankCredential): CredentialView {
  return {
    id: c.id,
    deviceLabel: c.deviceLabel,
    tokenPrefix: c.tokenPrefix,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    revokedAt: c.revokedAt?.toISOString() ?? null,
  };
}
