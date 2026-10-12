import { BadRequestException } from '@nestjs/common';

export interface IngestBankNotificationDto {
  clientEventId: string;
  app: string;
  title: string;
  body: string;
  notificationAt: Date | null;
}

const ALLOWED_KEYS = new Set([
  'clientEventId',
  'app',
  'title',
  'body',
  'notificationAt',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMITS = { app: 100, title: 200, body: 3000 } as const;

export const INGEST_MAX_BYTES = 4096;

/** Hand-rolled like the rest of the codebase; messages never echo values. */
export function parseIngestBody(raw: unknown): IngestBankNotificationDto {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Body must be a JSON object.');
  }
  const body = raw as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((k) => !ALLOWED_KEYS.has(k));
  if (unknownKey) {
    throw new BadRequestException(`Unexpected field "${unknownKey}".`);
  }

  const clientEventId = body.clientEventId;
  if (typeof clientEventId !== 'string' || !UUID.test(clientEventId.trim())) {
    throw new BadRequestException('clientEventId must be a UUID.');
  }

  return {
    clientEventId: clientEventId.trim().toLowerCase(),
    app: text(body.app, 'app', LIMITS.app, true),
    title: text(body.title, 'title', LIMITS.title, false),
    body: text(body.body, 'body', LIMITS.body, true),
    notificationAt: timestamp(body.notificationAt),
  };
}

function text(
  value: unknown,
  field: string,
  max: number,
  required: boolean,
): string {
  if (value === undefined || value === null) {
    if (required) throw new BadRequestException(`${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string.`);
  }
  if (required && !value.trim()) {
    throw new BadRequestException(`${field} is required.`);
  }
  if (value.length > max) {
    throw new BadRequestException(
      `${field} must be at most ${max} characters.`,
    );
  }
  return value;
}

// An unparseable date is dropped, not rejected: losing the event costs more.
function timestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = new Date(value.trim());
  return Number.isNaN(at.getTime()) ? null : at;
}
