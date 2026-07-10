import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthUser } from './entities/auth-user.entity';
import type {
  GoogleCallbackDto,
  GoogleAuthUrlQuery,
} from './dto/google-auth.dto';
import type { LoginDto } from './dto/login.dto';
import type { RefreshTokenDto } from './dto/refresh-token.dto';
import type { SignupDto } from './dto/signup.dto';
import {
  SupabaseAuthGuard,
  extractBearerToken,
} from './guards/supabase-auth.guard';
import type { AuthenticatedRequest } from './guards/supabase-auth.guard';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('signup')
  signup(@Body() payload: SignupDto) {
    if (!payload?.email || !payload?.password) {
      throw new BadRequestException('email and password are required');
    }
    return this.authService.signup(payload);
  }

  @Post('login')
  login(@Body() payload: LoginDto) {
    if (!payload?.email || !payload?.password) {
      throw new BadRequestException('email and password are required');
    }
    return this.authService.login(payload);
  }

  @Get('google')
  googleAuthUrl(@Query() query: GoogleAuthUrlQuery) {
    return this.authService.getGoogleAuthUrl(query?.redirectTo);
  }

  @Post('google/callback')
  googleCallback(@Body() payload: GoogleCallbackDto) {
    if (!payload?.code) {
      throw new BadRequestException('code is required');
    }
    return this.authService.googleCallback(payload);
  }

  @Post('refresh')
  refresh(@Body() payload: RefreshTokenDto) {
    if (!payload?.refreshToken) {
      throw new BadRequestException('refreshToken is required');
    }
    return this.authService.refresh(payload);
  }

  @Post('logout')
  logout(@Req() request: AuthenticatedRequest) {
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }
    return this.authService.logout(token);
  }

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
