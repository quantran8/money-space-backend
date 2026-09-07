import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CommonModule } from '../../common/common.module';
import { BillingModule } from '../billing/billing.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EntitlementGuard } from './guards/entitlement.guard';
import { HouseholdAccessGuard } from './guards/household-access.guard';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { AuthMiddleware } from './middleware/auth.middleware';
import { OauthVerifierStore } from './oauth-verifier.store';
import { AUTH_REPOSITORY } from './repositories/auth.repository.interface';
import { PrismaAuthRepository } from './repositories/prisma-auth.repository';
import { TokenVerifierService } from './token-verifier.service';

@Module({
  // BillingModule for the entitlement guard. The edge is one-way by design:
  // BillingModule imports nothing but CommonModule, precisely so this import
  // does not close a cycle.
  imports: [CommonModule, BillingModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SupabaseAuthGuard,
    HouseholdAccessGuard,
    EntitlementGuard,
    TokenVerifierService,
    OauthVerifierStore,
    {
      provide: AUTH_REPOSITORY,
      useClass: PrismaAuthRepository,
    },
    // Global guards: authenticate every route (except @Public), then enforce
    // household membership + capability on `/api/v1/households/:householdId/*`,
    // then the plan.
    // Order matters — SupabaseAuthGuard runs first to populate `req.user`, and
    // EntitlementGuard runs LAST because it reads `req.membership`, which
    // HouseholdAccessGuard is what sets. It costs one Reflector lookup on a
    // route with no `@RequirePremium()`, which is almost all of them.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    { provide: APP_GUARD, useClass: HouseholdAccessGuard },
    { provide: APP_GUARD, useClass: EntitlementGuard },
  ],
  exports: [AuthService, SupabaseAuthGuard, HouseholdAccessGuard, EntitlementGuard],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Attach the authenticated user (when a valid bearer token is present) to
    // every request. Non-blocking: protected routes still opt in via
    // SupabaseAuthGuard.
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
