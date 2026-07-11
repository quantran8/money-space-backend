import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CommonModule } from '../../common/common.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { HouseholdAccessGuard } from './guards/household-access.guard';
import { SupabaseAuthGuard } from './guards/supabase-auth.guard';
import { AuthMiddleware } from './middleware/auth.middleware';
import { AUTH_REPOSITORY } from './repositories/auth.repository.interface';
import { PrismaAuthRepository } from './repositories/prisma-auth.repository';
import { TokenVerifierService } from './token-verifier.service';

@Module({
  imports: [CommonModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SupabaseAuthGuard,
    HouseholdAccessGuard,
    TokenVerifierService,
    {
      provide: AUTH_REPOSITORY,
      useClass: PrismaAuthRepository,
    },
    // Global guards: authenticate every route (except @Public), then enforce
    // household membership + capability on `/api/households/:householdId/*`.
    // Order matters — SupabaseAuthGuard runs first to populate `req.user`.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    { provide: APP_GUARD, useClass: HouseholdAccessGuard },
  ],
  exports: [AuthService, SupabaseAuthGuard, HouseholdAccessGuard],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Attach the authenticated user (when a valid bearer token is present) to
    // every request. Non-blocking: protected routes still opt in via
    // SupabaseAuthGuard.
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
