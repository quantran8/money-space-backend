import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
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
    TokenVerifierService,
    {
      provide: AUTH_REPOSITORY,
      useClass: PrismaAuthRepository,
    },
  ],
  exports: [AuthService, SupabaseAuthGuard],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Attach the authenticated user (when a valid bearer token is present) to
    // every request. Non-blocking: protected routes still opt in via
    // SupabaseAuthGuard.
    consumer.apply(AuthMiddleware).forRoutes('*');
  }
}
