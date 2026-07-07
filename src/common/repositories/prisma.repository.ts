import { PrismaService } from '../../database/prisma/prisma.service';

export type DbRow = Record<string, any>;

export abstract class PrismaRepository {
  constructor(protected readonly prisma: PrismaService) {}

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
