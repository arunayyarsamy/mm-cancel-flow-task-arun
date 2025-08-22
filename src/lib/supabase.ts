// src/lib/supabase.ts
// Supabase client + focused data-access helpers used across the cancel flow.
// Keeps DB I/O in one place. Uses RPCs (SECURITY DEFINER) to stay RLS-safe.

import { createClient } from '@supabase/supabase-js'

/**
 * Normalize PostgREST results that may be a row object or a single-element array.
 */
function firstRow<T>(v: any): T | null {
  return Array.isArray(v) ? (v?.[0] ?? null) : (v ?? null);
}

// --- Client -----------------------------------------------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // We don't use OAuth in this task; avoid parsing the URL for sessions
    detectSessionInUrl: false,
    // Avoid writing tokens to localStorage/cookies in this mock app
    persistSession: false,
    // No auto refresh needed without persisted sessions
    autoRefreshToken: false,
  },
})

// --- Types (mirrors minimal columns we actually use) ------------------
export type DbUser = { id: string; email: string; created_at?: string | null }

export type SubscriptionRow = {
  id?: string
  user_id: string
  status?: 'active' | 'pending_cancellation' | 'cancelled' | string | null
  monthly_price?: number | null
  created_at?: string | null
}

export type CancellationRow = {
  id: string
  user_id: string
  subscription_id?: string | null
  downsell_variant?: 'A' | 'B' | null
  accepted_downsell?: boolean | null
  reason?: string | null
  // mini-survey
  attributed_to_mm?: boolean | null
  applied_count?: '0' | '1-5' | '6-20' | '20+' | null
  emailed_count?: '0' | '1-5' | '6-20' | '20+' | null
  interview_count?: '0' | '1-2' | '3-5' | '5+' | null
  // visa step
  visa_has_lawyer?: boolean | null
  visa_type?: string | null
  created_at?: string | null
}

// --- Read helpers ----------------------------------------------------

/** Load users for the tester-only selector via a narrow view (RLS-safe). */
export async function fetchUsers(): Promise<DbUser[]> {
  const { data, error } = await supabase
    .from('user_emails_view')
    .select('id,email')

  if (error) throw error
  return (data ?? []) as DbUser[]
}

/** Fetch the latest subscription for a user via RPC (RLS-safe). */
export async function fetchLatestSubscription(userId: string): Promise<SubscriptionRow | null> {
  if (!userId) return null

  const { data, error } = await supabase.rpc('fetch_latest_subscription', {
    target_user: userId,
  })

  if (error) throw error

  // RPC returning TABLE can come back as an array (0..1 rows) depending on PostgREST
  const row = Array.isArray(data) ? data?.[0] : data
  return (row as SubscriptionRow) ?? null
}

// --- RPC helpers (RLS-safe) ---------------------------------------

/** Mark the current cancellation as having accepted the downsell. */
export async function acceptDownsell(cancellationId: string) {
  if (!cancellationId) throw new Error('cancellationId required')
  const { error } = await supabase.rpc('accept_downsell', { p_cancellation_id: cancellationId })
  if (error) throw error
}

/**
 * Persist step-2 answers for the Found-a-Job branch via JSONB RPC.
 * Server sanitizes HTML from `reason` and handles null/empty values.
 */
export async function saveFoundJobAnswersRpc(
  cancellationId: string,
  payload: {
    attributed_to_mm: boolean | null
    applied_count: '0' | '1-5' | '6-20' | '20+' | ''
    emailed_count: '0' | '1-5' | '6-20' | '20+' | ''
    interview_count: '0' | '1-2' | '3-5' | '5+' | ''
    reason?: string
  }
) {
  if (!cancellationId) throw new Error('cancellationId required');

  // Build JSONB payload. Empty strings become nulls to avoid bad enums.
  const payloadDb = {
    attributed_to_mm: payload.attributed_to_mm,
    applied_count: payload.applied_count === '' ? null : payload.applied_count,
    emailed_count: payload.emailed_count === '' ? null : payload.emailed_count,
    interview_count: payload.interview_count === '' ? null : payload.interview_count,
    reason: (payload.reason ?? '').trim() || null,
  } as const;

  const { error } = await supabase.rpc('save_found_job_answers', {
    p_cancellation_id: cancellationId,
    p_payload: payloadDb,
  });
  if (error) throw error;
}

/** Finalize the Found-a-Job path and set subscription status to cancelled. */
export async function finalizeFoundJob(cancellationId: string, hasLawyer: boolean, visaType: string) {
  if (!cancellationId) throw new Error('cancellationId required')
  const { error } = await supabase.rpc('finalize_found_job', {
    p_cancellation_id: cancellationId,
    p_visa_has_lawyer: hasLawyer,
    p_visa_type: (visaType ?? '').trim(),
  })
  if (error) throw error
}

/** Finalize the Still-Looking path and set subscription status to cancelled. */
export async function finalizeStillLooking(cancellationId: string, reason: string) {
  if (!cancellationId) throw new Error('cancellationId required')
  const { error } = await supabase.rpc('finalize_still_looking', {
    p_cancellation_id: cancellationId,
    p_reason: (reason ?? '').trim(),
  })
  if (error) throw error
}

/**
 * Ask the server to (idempotently) create/fetch the latest cancellation row
 * and assign a balanced A/B variant. Returns the id + variant.
 */
export async function assignBalancedDownsell(userId: string) {
  if (!userId) throw new Error('userId required');
  const { data, error } = await supabase.rpc('assign_balanced_downsell', { p_user_id: userId });
  if (error) throw error;

  // Supabase may return a single row or a single-element array
  const raw = Array.isArray(data) ? data?.[0] : data;
  if (raw && typeof raw === 'object') {
    const r = raw as { cancellation_id?: string; downsell_variant?: 'A' | 'B' | string };
    if (r.cancellation_id && (r.downsell_variant === 'A' || r.downsell_variant === 'B')) {
      return { cancellation_id: r.cancellation_id, downsell_variant: r.downsell_variant as 'A' | 'B' };
    }
  }
  throw new Error('assign_balanced_downsell returned no data');
}

/**
 * Retrieve the latest cancellation for a user. Prefers RPC; falls back to a
 * direct table query (still constrained by RLS).
 */
export async function fetchLatestCancellationForUser(userId: string): Promise<CancellationRow | null> {
  if (!userId) return null;

  function dlog(...args: any[]) {
    console.debug('[fetchLatestCancellationForUser]', ...args);
  }

  // Try RPC first
  dlog('Calling RPC fetch_latest_cancellation with', userId);
  try {
    const { data, error } = await supabase.rpc('fetch_latest_cancellation', { p_user_id: userId });
    if (error) {
      dlog('RPC fetch_latest_cancellation error:', error);
      throw error;
    }
    const row = Array.isArray(data) ? data?.[0] : data;
    if (row) {
      dlog('RPC fetch_latest_cancellation result:', row);
      return row as CancellationRow;
    }
  } catch (e) {
    dlog('RPC fetch_latest_cancellation failed:', e);
  }

  // Fallback to previous query
  dlog('Falling back to .from("cancellations") query');
  const { data, error } = await supabase
    .from('cancellations')
    .select('id, user_id, subscription_id, downsell_variant, accepted_downsell, reason, attributed_to_mm, applied_count, emailed_count, interview_count, visa_has_lawyer, visa_type, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  const row = firstRow<CancellationRow>(data);
  dlog('Fallback query resolved row:', row);
  return row ?? null;
}

/**
 * Load persisted answers for prefill. Prefers RPC and falls back to direct select.
 */
export async function fetchCancellationAnswers(
  cancellationId: string
): Promise<
  | Pick<
      CancellationRow,
      | 'attributed_to_mm'
      | 'applied_count'
      | 'emailed_count'
      | 'interview_count'
      | 'reason'
      | 'visa_has_lawyer'
      | 'visa_type'
    >
  | null
> {
  if (!cancellationId) return null;

  function dlog(...args: any[]) {
    console.debug('[fetchCancellationAnswers]', ...args);
  }

  // Try RPC first
  dlog('Calling RPC fetch_cancellation_answers with', cancellationId);
  try {
    const { data, error } = await supabase.rpc('fetch_cancellation_answers', { p_cancellation_id: cancellationId });
    if (error) {
      dlog('RPC fetch_cancellation_answers error:', error);
      throw error;
    }
    const row = Array.isArray(data) ? data?.[0] : data;
    if (row) return row as Pick<CancellationRow,'attributed_to_mm'|'applied_count'|'emailed_count'|'interview_count'|'reason'|'visa_has_lawyer'|'visa_type'>;
  } catch (e) {
    dlog('RPC fetch_cancellation_answers failed:', e);
  }

  // Fallback to previous query
  dlog('Falling back to .from("cancellations") select query');
  const { data, error } = await supabase
    .from('cancellations')
    .select(
      'attributed_to_mm, applied_count, emailed_count, interview_count, reason, visa_has_lawyer, visa_type'
    )
    .eq('id', cancellationId)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  const row = firstRow<Pick<CancellationRow,'attributed_to_mm'|'applied_count'|'emailed_count'|'interview_count'|'reason'|'visa_has_lawyer'|'visa_type'>>(data);
  return row ?? null;
}

// --- Small utility ---------------------------------------------------

/** Local 50/50 chooser - Backup for supabase server side choooser*/
export function chooseVariantAB(): 'A' | 'B' {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return (buf[0] % 2 === 0) ? 'A' : 'B'
  }
  // Fallback (non-crypto environments)
  return Math.random() < 0.5 ? 'A' : 'B'
}