import { Injectable } from '@nestjs/common';
import { BUILD_INFO } from './version';

@Injectable()
export class AppService {
  getRoot() {
    return {
      name: 'money-space-backend',
      status: 'ok',
      version: BUILD_INFO.version,
      commit: BUILD_INFO.commit,
      endpoints: [
        '/health',
        '/api/v1/households',
        '/api/v1/households/:householdId/dashboard',
        '/api/v1/households/:householdId/assets',
        '/api/v1/households/:householdId/debts',
        '/api/v1/households/:householdId/members',
        '/api/v1/households/:householdId/money-events',
        '/api/v1/households/:householdId/upcoming-payments',
        '/api/v1/households/:householdId/financial-goals',
      ],
    };
  }

  getHealth() {
    return {
      status: 'ok',
      service: 'money-space-backend',
      // Which build is answering, so `curl /health` identifies what is live.
      version: BUILD_INFO.version,
      commit: BUILD_INFO.commit,
      builtAt: BUILD_INFO.builtAt,
      timestamp: new Date().toISOString(),
    };
  }
}
