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
  console.log(row)
  return (row as SubscriptionRow) ?? null
}

// --- Write helpers used by the cancellation flow ---------------------

/** Mark subscription as pending cancellation. */
export async function markSubscriptionPendingCancellation(userId: string): Promise<void> {
  if (!userId) throw new Error('userId required')
  const { error } = await supabase
    .from('subscriptions')
    .update({ pending_cancellation: true, status: 'pending_cancellation' })
    .eq('user_id', userId)

  if (error) throw error
}

/**
 * Create (or reuse latest) cancellation row and persist downsell variant once.
 * Deterministic behavior is handled by the caller’s first-assignment; we simply
 * refuse to overwrite an existing variant if one exists.
 */
export async function createOrReuseCancellation(
  userId: string,
  params: { subscriptionId?: string | null; variant: 'A' | 'B' }
): Promise<CancellationRow> {
  if (!userId) throw new Error('userId required')

  // If a recent cancellation exists with a variant, reuse it.
  const { data: existing, error: qErr } = await supabase
    .from('cancellations')
    .select('id,user_id,subscription_id,downsell_variant,accepted_downsell,created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)

  if (qErr) throw qErr
  const row = existing?.[0] as CancellationRow | undefined
  if (row && row.downsell_variant) {
    return row
  }

  // Insert a new row with the assigned variant (or set variant on latest null one)
  if (row && !row.downsell_variant) {
    const { data: updated, error: uErr } = await supabase
      .from('cancellations')
      .update({ downsell_variant: params.variant })
      .eq('id', row.id)
      .select('*')
      .single()
    if (uErr) throw uErr
    return updated as CancellationRow
  }

  const { data: inserted, error: iErr } = await supabase
    .from('cancellations')
    .insert({
      user_id: userId,
      subscription_id: params.subscriptionId ?? null,
      downsell_variant: params.variant,
    })
    .select('*')
    .single()

  if (iErr) throw iErr
  return inserted as CancellationRow
}

/** Patch a cancellation row (only minimal fields we use). */
export async function updateCancellation(
  id: string,
  patch: Partial<Omit<CancellationRow, 'id' | 'user_id'>>
): Promise<void> {
  if (!id) throw new Error('cancellation id required')
  const { error } = await supabase
    .from('cancellations')
    .update(patch)
    .eq('id', id)

  if (error) throw error
}

// --- Found Job / Cancellation extensions ------------------------------

/** Ensure a cancellation row exists for a user (create if not) */
export async function ensureCancellation(userId: string, subscriptionId?: string | null): Promise<CancellationRow> {
  if (!userId) throw new Error('userId required')
  const { data: row, error } = await supabase
    .from('cancellations')
    .insert({ user_id: userId, subscription_id: subscriptionId ?? null })
    .select('*')
    .single()
  if (error) throw error
  return row as CancellationRow
}

/** Save mini‑survey answers about found job experience */
export async function saveFoundJobAnswers(cancellationId: string, answers: {
  attributed_to_mm?: boolean
  applied_count?: '0' | '1-5' | '6-20' | '20+'
  emailed_count?: '0' | '1-5' | '6-20' | '20+'
  interview_count?: '0' | '1-2' | '3-5' | '5+'
}): Promise<void> {
  if (!cancellationId) throw new Error('cancellationId required')
  const { error } = await supabase
    .from('cancellations')
    .update(answers)
    .eq('id', cancellationId)
  if (error) throw error
}

/** Finalize cancellation row after found job flow */
export async function finalizeFoundJobCancellation(cancellationId: string): Promise<void> {
  if (!cancellationId) throw new Error('cancellationId required')
  const { error } = await supabase
    .from('cancellations')
    .update({ reason: 'found_job' })
    .eq('id', cancellationId)
  if (error) throw error
}

// Namespaced export for integration
export const CancellationFlowPersist = {
  ensureCancellation,
  saveFoundJobAnswers,
  finalizeFoundJobCancellation,
} as const

// --- Small utility ---------------------------------------------------

/** Secure 50/50 variant chooser (A/B). Caller persists via createOrReuseCancellation. */
export function chooseVariantAB(): 'A' | 'B' {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return (buf[0] % 2 === 0) ? 'A' : 'B'
  }
  // Fallback (non-crypto environments)
  return Math.random() < 0.5 ? 'A' : 'B'
}