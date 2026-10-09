#!/usr/bin/env node
// Generates a password-recovery link for one user via Supabase's Admin API,
// WITHOUT sending any email — so it works even while SMTP/email delivery is
// broken or misconfigured (see the Site URL / Redirect URLs issue in
// Supabase's Authentication settings). Copy the printed link and send it to
// the user yourself (WhatsApp, Slack, etc.).
//
// This is a standalone admin tool, run locally by hand — it is NOT part of
// the deployed app, is never imported by src/, and never ships in `dist/`.
//
// USAGE
//   SUPABASE_SERVICE_ROLE_KEY=xxxxx node scripts/generate-reset-link.mjs someone@example.com
//
// The service_role key is the SECRET key from Supabase's dashboard
// (Project Settings -> API -> service_role, "reveal") — NOT the public
// anon key already in .env. It bypasses every RLS policy, so:
//   - never put it in .env, in any committed file, or in this script
//   - only ever pass it as a one-off environment variable, in your own
//     terminal, right before running this
//   - treat it like a password; rotate it in Supabase if it ever leaks
//
// The project URL is read from SUPABASE_URL if set, otherwise falls back to
// VITE_SUPABASE_URL in .env (that one is NOT secret — it's the same public
// project URL already shipped in the built app).

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const email = process.argv[2];
const redirectTo = process.argv[3] || process.env.APP_URL || 'https://dmtaskdashboard.netlify.app';

if (!email) {
  console.error('Usage: SUPABASE_SERVICE_ROLE_KEY=<secret> node scripts/generate-reset-link.mjs <email> [redirectTo]');
  process.exit(1);
}

function readSupabaseUrlFromEnvFile() {
  const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const envPath = path.join(projectRoot, '.env');
  try {
    const text = readFileSync(envPath, 'utf8');
    const match = text.match(/^VITE_SUPABASE_URL=(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const supabaseUrl = process.env.SUPABASE_URL || readSupabaseUrlFromEnvFile();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error('Could not determine the Supabase project URL. Set SUPABASE_URL or make sure .env has VITE_SUPABASE_URL.');
  process.exit(1);
}
if (!serviceRoleKey) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY. Get it from Supabase -> Project Settings -> API -> service_role (reveal), then re-run as:');
  console.error('  SUPABASE_SERVICE_ROLE_KEY=<paste> node scripts/generate-reset-link.mjs ' + email);
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase.auth.admin.generateLink({
  type: 'recovery',
  email: email.trim().toLowerCase(),
  options: { redirectTo },
});

if (error) {
  console.error('Failed to generate link:', error.message);
  // The same Site URL / Redirect URLs allow-list used for the normal email
  // flow still applies here — if redirectTo isn't on that list, this is
  // the most likely reason this failed.
  process.exit(1);
}

console.log('\nRecovery link for', email, '\n');
console.log(data.properties.action_link);
console.log('\nThis link is single-use and expires (Supabase default: 1 hour). Send it to the user directly.\n');
