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

function makeClient(url: string, key: string): SupabaseClient<Database> {
  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        'X-Client-Info': 'money-space-backend',
      },
    },
  });
}

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
