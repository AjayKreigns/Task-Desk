import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (supabaseUrl && supabaseAnonKey && supabaseUrl !== 'YOUR_SUPABASE_URL')
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The password-reset email link lands back on this app with a token in
        // the URL; this is what turns it into a real session automatically.
        detectSessionInUrl: true,
        // Not `td_`-prefixed on purpose. src/lib/localCache.js clears the `td_*`
        // mirror keys on sign-out and on a different user signing in — if the
        // session lived under a `td_` key it would get swept up in that and the
        // user would be logged out mid-clear.
        storageKey: 'td-auth',
      },
    })
  : null;

export const isSupabaseConfigured = () => !!supabase;
