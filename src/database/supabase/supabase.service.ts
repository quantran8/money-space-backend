import { Injectable } from '@nestjs/common';
import { SupabaseClient, createClient } from '@supabase/supabase-js';

type Database = {
  public: {
    Tables: Record<string, unknown>;
    Views: Record<string, unknown>;
    Functions: Record<string, unknown>;
    Enums: Record<string, string>;
    CompositeTypes: Record<string, unknown>;
  };
};

function makeClient(
  url: string,
  key: string,
  auth?: Record<string, unknown>,
): SupabaseClient<Database> {
  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      ...auth,
    },
    global: {
      headers: {
        'X-Client-Info': 'money-space-backend',
      },
    },
  });
}

/**
 * Minimal storage the OAuth client writes its PKCE `code_verifier` into.
 * supabase-js JSON-encodes on write and decodes on read, so values are kept
 * verbatim here — parsing them would corrupt the round-trip.
 */
export type SupabaseAuthStorage = {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void | Promise<void>;
};

/** Namespace for the PKCE verifier entry; the suffix is supabase-js's own. */
export const OAUTH_STORAGE_KEY = 'money-space-oauth';
export const OAUTH_VERIFIER_ITEM = `${OAUTH_STORAGE_KEY}-code-verifier`;

@Injectable()
export class SupabaseService {
  private readonly url = process.env.SUPABASE_URL;
  private readonly anonKey = process.env.SUPABASE_ANON_KEY;
  private readonly serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  readonly publicClient =
    this.url && this.anonKey ? makeClient(this.url, this.anonKey) : null;

  readonly adminClient =
    this.url && this.serviceRoleKey
      ? makeClient(this.url, this.serviceRoleKey)
      : null;

  hasPublicClient() {
    return this.publicClient !== null;
  }

  hasAdminClient() {
    return this.adminClient !== null;
  }

  getPublicClient() {
    if (!this.publicClient) {
      throw new Error(
        'SUPABASE_URL or SUPABASE_ANON_KEY is missing. Check backend/.env.',
      );
    }

    return this.publicClient;
  }

  /**
   * A per-request client for the Google OAuth round-trip.
   *
   * PKCE needs the `code_verifier` minted when the authorization URL is built
   * to still be readable when the code comes back — a different request, and on
   * production a possibly different instance. A fresh client bound to caller-
   * supplied storage is what lets that value be captured and replayed; the
   * shared clients stay stateless.
   */
  getOAuthClient(storage: SupabaseAuthStorage) {
    if (!this.url || !this.anonKey) {
      throw new Error(
        'SUPABASE_URL or SUPABASE_ANON_KEY is missing. Check backend/.env.',
      );
    }

    // persistSession must be true: supabase-js ignores a supplied `storage` and
    // falls back to an internal in-memory adapter when it is false, which loses
    // the verifier the moment the request ends. Safe here because the storage is
    // ours and each call gets its own client.
    return makeClient(this.url, this.anonKey, {
      flowType: 'pkce',
      persistSession: true,
      storage,
      storageKey: OAUTH_STORAGE_KEY,
    });
  }

  getAdminClient() {
    if (!this.adminClient) {
      throw new Error(
        'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. Check backend/.env.',
      );
    }

    return this.adminClient;
  }

  from(table: string) {
    return this.getPublicClient().from(table);
  }

  fromAdmin(table: string) {
    return this.getAdminClient().from(table);
  }
}
