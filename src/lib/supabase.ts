import { createClient } from '@supabase/supabase-js';

// The project URL must be the bare origin; tolerate a pasted "/rest/v1/" suffix.
const url = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

export const isSupabaseConfigured = Boolean(url && key);

// Read-only anonymous client: no accounts, so no session storage or token refresh.
export const supabase = isSupabaseConfigured
  ? createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null;
