export type AuthProvider = 'email' | 'google';

export interface AuthUser {
  id: string;
  email: string | null;
  fullName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  provider: AuthProvider;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt: number | null;
  tokenType: string;
}

export interface AuthResult {
  user: AuthUser;
  session: AuthSession | null;
}
