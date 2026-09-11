import { BadRequestException, ConflictException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import {
  NotHouseholdMemberException,
  UnauthenticatedException,
} from '../errors/coded.exceptions';
import type { AnalyticsService } from '../analytics/analytics.service';

type Body = Record<string, unknown>;

function run(exception: unknown, env?: string) {
  const previous = process.env.NODE_ENV;
  if (env === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env;

  const json = jest.fn();
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status: () => ({ json }) }),
      getRequest: () => ({ url: '/api/v1/households/hh-1', method: 'GET' }),
    }),
  };
  const analytics = { captureException: jest.fn() } as unknown as AnalyticsService;

  new HttpExceptionFilter(analytics).catch(exception, host as never);

  process.env.NODE_ENV = previous;
  return json.mock.calls[0][0] as Body;
}

describe('HttpExceptionFilter', () => {
  describe('5xx detail', () => {
    // The switch is an allow-list: a box with no NODE_ENV must fail closed
    // rather than start echoing Prisma at whoever is holding the phone.
    it.each([['production'], ['staging'], [undefined]])(
      'hides the real message when NODE_ENV is %s',
      (env) => {
        const body = run(new Error('connect ECONNREFUSED 10.0.0.1:5432'), env);
        expect(body.message).toBe('Internal server error');
      },
    );

    it.each([['development'], ['test']])('shows it when NODE_ENV is %s', (env) => {
      const body = run(new Error('connect ECONNREFUSED 10.0.0.1:5432'), env);
      expect(body.message).toBe('connect ECONNREFUSED 10.0.0.1:5432');
    });
  });

  describe('structured fields', () => {
    it('forwards the code a coded exception carries', () => {
      expect(run(new NotHouseholdMemberException()).code).toBe(
        'not_household_member',
      );
      expect(run(new UnauthenticatedException()).code).toBe('unauthenticated');
    });

    // These were thrown by services and dropped by the filter for months.
    it('forwards impact so the client can offer a cascade delete', () => {
      const body = run(
        new ConflictException({
          message: 'still linked',
          code: 'asset_in_use',
          impact: { goals: 2 },
        }),
      );
      expect(body.code).toBe('asset_in_use');
      expect(body.impact).toEqual({ goals: 2 });
    });

    it('omits code entirely when the throw site names none', () => {
      expect(run(new BadRequestException('plannedDate is required'))).not.toHaveProperty(
        'code',
      );
    });
  });
});
