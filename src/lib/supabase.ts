// src/lib/supabase.ts
// Supabase client configuration for database connections
// Does not include authentication setup or advanced features
// src/lib/supabase.ts
// Supabase client & tiny data-access helpers used across the app.
// Keeps all DB I/O in one place. No server-role client here.

import { createClient } from '@supabase/supabase-js'

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
  status?: 'active' | 'pending_cancellation' | 'cancelled' | 'trialing' | 'past_due' | string | null
  pending_cancellation?: boolean | null
  current_period_end?: string | null
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

/**
 * This is for tester only purpose
 * Load all users (for the selector).
 * We use a restricted view (user_emails_view) to maintain RLS and only expose id, email
 * instead of querying the full users table directly.
 */
export async function fetchUsers(): Promise<DbUser[]> {
  const { data, error } = await supabase
    .from('user_emails_view')
    .select('id,email')

  if (error) throw error
  return (data ?? []) as DbUser[]
}

/** Load the most recent subscription for a user. */
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

export async function beginCancellation(userId: string, variant: 'A' | 'B' | null) {
  if (!userId) throw new Error('userId required')
  const { data, error } = await supabase.rpc('begin_cancellation', {
    p_user_id: userId,
    p_downsell_variant: variant,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data?.[0] : data
  return row as { cancellation_id: string; downsell_variant: 'A' | 'B' | null }
}

export async function acceptDownsell(cancellationId: string) {
  if (!cancellationId) throw new Error('cancellationId required')
  const { error } = await supabase.rpc('accept_downsell', { p_cancellation_id: cancellationId })
  if (error) throw error
}

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
  if (!cancellationId) throw new Error('cancellationId required')
  const { error } = await supabase.rpc('save_found_job_answers', {
    p_cancellation_id: cancellationId,
    p_attributed_to_mm: payload.attributed_to_mm,
    p_applied: payload.applied_count || null,
    p_emailed: payload.emailed_count || null,
    p_interview: payload.interview_count || null,
    p_reason: (payload.reason ?? '').trim() || null,
  })
  if (error) throw error
}

export async function finalizeFoundJob(cancellationId: string, hasLawyer: boolean, visaType: string) {
  if (!cancellationId) throw new Error('cancellationId required')
  const { error } = await supabase.rpc('finalize_found_job', {
    p_cancellation_id: cancellationId,
    p_visa_has_lawyer: hasLawyer,
    p_visa_type: (visaType ?? '').trim(),
  })
  if (error) throw error
}

export async function finalizeStillLooking(cancellationId: string, reason: string) {
  if (!cancellationId) throw new Error('cancellationId required')
  const { error } = await supabase.rpc('finalize_still_looking', {
    p_cancellation_id: cancellationId,
    p_reason: (reason ?? '').trim(),
  })
  if (error) throw error
}

export async function assignBalancedDownsell(userId: string) {
    if (!userId) throw new Error('userId required')
    const { data, error } = await supabase.rpc('assign_balanced_downsell', {
      p_user_id: userId,
    })
    if (error) throw error

    console.log(data, error)
  
    // PostgREST can serialize a RETURNS TABLE/RECORD as either a row object,
    // an array with a single row, or a TEXT tuple depending on function shape.
    // Handle all cases defensively.
    const raw = Array.isArray(data) ? data?.[0] : data
  
    // 1) Direct object shape
    if (raw && typeof raw === 'object' && 'cancellation_id' in raw && 'downsell_variant' in raw) {
      const r = raw as { cancellation_id?: string; downsell_variant?: 'A' | 'B' | string }
      if (r.cancellation_id && (r.downsell_variant === 'A' || r.downsell_variant === 'B')) {
        return {
          cancellation_id: r.cancellation_id,
          downsell_variant: r.downsell_variant as 'A' | 'B',
        }
      }
    }
  
    // 2) TEXT tuple e.g. "(uuid,A)" or ("uuid",A)
    if (typeof data === 'string' || typeof raw === 'string') {
      const s = String(raw ?? data)
      const m = s.match(/\(?["']?([0-9a-fA-F-]{36})["']?\s*,\s*([AB])\)?/)
      if (m) {
        return { cancellation_id: m[1], downsell_variant: m[2] as 'A' | 'B' }
      }
      // Sometimes the RPC may return a JSON string
      try {
        const maybe = JSON.parse(s)
        if (maybe?.cancellation_id && (maybe.downsell_variant === 'A' || maybe.downsell_variant === 'B')) {
          return {
            cancellation_id: String(maybe.cancellation_id),
            downsell_variant: maybe.downsell_variant as 'A' | 'B',
          }
        }
      } catch {}
    }
  
    throw new Error('assign_balanced_downsell returned no data')
  }

// --- Small utility ---------------------------------------------------

/**
 * Fallback local 50/50 chooser (crypto-strong when available).
 * Prefer server-side `assignBalancedDownsell` for perfectly balanced groups.
 */
export function chooseVariantAB(): 'A' | 'B' {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return (buf[0] % 2 === 0) ? 'A' : 'B'
  }
  // Fallback (non-crypto environments)
  return Math.random() < 0.5 ? 'A' : 'B'
}