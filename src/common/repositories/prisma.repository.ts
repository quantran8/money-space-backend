import {
  PrismaService,
  PrismaTransactionClient,
} from '../../database/prisma/prisma.service';

export type DbRow = Record<string, any>;

export abstract class PrismaRepository {
  constructor(private readonly prismaService: PrismaService) {}

  /**
   * The Prisma client to run queries against. Resolves to the active
   * transaction client when the caller is inside `PrismaService.runInTransaction`
   * (so every write joins that transaction), otherwise the root client.
   *
   * Subclasses keep using `this.prisma.*` exactly as before — transaction
   * participation is transparent, no per-method `tx` argument needed.
   */
  protected get prisma(): PrismaTransactionClient | PrismaService {
    return this.prismaService.client;
  }

  /**
   * Run `work` inside a transaction, joining an outer one if the caller is
   * already inside `PrismaService.runInTransaction`. Use this instead of
   * `this.prisma.$transaction(...)` inside a repository: the resolved
   * `this.prisma` may be a transaction client (which has no `$transaction`),
   * so calling it directly would break when nested under a service-level
   * transaction.
   */
  protected runInTransaction<T>(
    work: (tx: PrismaTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prismaService.runInTransaction(work);
  }

  protected toDate(value: string | Date | null | undefined): Date | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return value;
    }

    return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  }

  protected asUuid(value: string | undefined): string | null {
    if (!value) {
      return null;
    }

    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
      ? value
      : null;
  }

  protected makeInitials(value: string): string {
    return value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
  }
}
