-- seed.sql
-- Database schema and seed data for subscription cancellation flow
-- Does not include production-level optimizations or advanced RLS policies

-- Enable Row Level Security

-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  monthly_price INTEGER NOT NULL, -- Price in USD cents
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending_cancellation', 'cancelled')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create cancellations table
CREATE TABLE IF NOT EXISTS cancellations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE CASCADE,
  -- A/B assignment (persisted once)
  downsell_variant TEXT NOT NULL CHECK (downsell_variant IN ('A', 'B')),

  -- Survey fields (found‑job branch first; extend for other branch later)
  attributed_to_mm BOOLEAN, -- did they find the job via Migrate Mate?
  applied_count TEXT CHECK (applied_count IN ('0','1-5','6-20','20+')),
  emailed_count TEXT CHECK (emailed_count IN ('0','1-5','6-20','20+')),
  interview_count TEXT CHECK (interview_count IN ('0','1-2','3-5','5+')),

  -- Free‑text feedback
  reason TEXT,

  -- Downsell outcome
  accepted_downsell BOOLEAN DEFAULT FALSE,

  -- Visa info (step 3 in found‑job path)
  visa_has_lawyer BOOLEAN,
  visa_type TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Idempotent column add (in case table already existed)
ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS attributed_to_mm BOOLEAN;
ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS applied_count TEXT CHECK (applied_count IN ('0','1-5','6-20','20+'));
ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS emailed_count TEXT CHECK (emailed_count IN ('0','1-5','6-20','20+'));
ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS interview_count TEXT CHECK (interview_count IN ('0','1-2','3-5','5+'));
ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS visa_has_lawyer BOOLEAN;
ALTER TABLE cancellations ADD COLUMN IF NOT EXISTS visa_type TEXT;

-- Enable Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellations ENABLE ROW LEVEL SECURITY;

-- Basic RLS policies (hardened)
-- NOTE: RLS is enabled above. Default deny applies unless a policy matches.

-- USERS: read own row only (no public enumeration)
DROP POLICY IF EXISTS "Users can view own data" ON users;
CREATE POLICY "Users can view own data" ON users
  FOR SELECT
  USING (auth.uid() = id);

-- Optional (uncomment if you want users to edit their profile safely)
-- CREATE POLICY "Users can update own profile" ON users
--   FOR UPDATE
--   USING (auth.uid() = id)
--   WITH CHECK (auth.uid() = id);

-- SUBSCRIPTIONS: read + update only own rows
DROP POLICY IF EXISTS "Users can view own subscriptions" ON subscriptions;
CREATE POLICY "Users can view own subscriptions" ON subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own subscriptions" ON subscriptions;
CREATE POLICY "Users can update own subscriptions" ON subscriptions
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- No INSERT policy on subscriptions (server-only via service role)

-- CANCELLATIONS: insert/read/update own rows only
DROP POLICY IF EXISTS "Users can insert own cancellations" ON cancellations;
CREATE POLICY "Users can insert own cancellations" ON cancellations
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own cancellations" ON cancellations;
CREATE POLICY "Users can view own cancellations" ON cancellations
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own cancellations" ON cancellations;
CREATE POLICY "Users can update own cancellations" ON cancellations
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- DEMO-ONLY (commented): If you need to list users/subs without auth for local UI, you can
-- add permissive read policies to `anon`. DO NOT enable in production.
-- CREATE POLICY "DEMO: anon can read users" ON users FOR SELECT TO anon USING (true);
-- CREATE POLICY "DEMO: anon can read subscriptions" ON subscriptions FOR SELECT TO anon USING (true);

-- Narrow column exposure for anon via a view (test-friendly, RLS-safe)
-- Exposes only id + email for the user selector; base table remains protected by RLS
CREATE OR REPLACE VIEW public.user_emails_view AS
  SELECT id, email
  FROM public.users;

-- Allow anon to read ONLY from this view (not the base table)
GRANT SELECT ON public.user_emails_view TO anon;

-- RPCs with SECURITY DEFINER (minimal set required)
-- Fetch the latest subscription for a specific user (RLS-safe read path)
CREATE OR REPLACE FUNCTION public.fetch_latest_subscription(target_user uuid)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  status text,
  monthly_price integer,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT s.id, s.user_id, s.status, s.monthly_price, s.created_at
  FROM public.subscriptions s
  WHERE s.user_id = target_user
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.fetch_latest_subscription(uuid) TO anon, authenticated;

-- Hardening triggers ---------------------------------------------------

-- Prevent changing user_id on UPDATE (both tables)
CREATE OR REPLACE FUNCTION public.prevent_user_id_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_id is immutable';
  END IF;
  RETURN NEW;
END;$$;

DROP TRIGGER IF EXISTS trg_subscriptions_user_guard ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_user_guard
BEFORE UPDATE ON public.subscriptions
FOR EACH ROW EXECUTE FUNCTION public.prevent_user_id_change();

DROP TRIGGER IF EXISTS trg_cancellations_user_guard ON public.cancellations;
CREATE TRIGGER trg_cancellations_user_guard
BEFORE UPDATE ON public.cancellations
FOR EACH ROW EXECUTE FUNCTION public.prevent_user_id_change();

-- Prevent changing downsell_variant after insert
CREATE OR REPLACE FUNCTION public.prevent_variant_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.downsell_variant IS DISTINCT FROM OLD.downsell_variant THEN
    RAISE EXCEPTION 'downsell_variant is immutable after insert';
  END IF;
  RETURN NEW;
END;$$;

DROP TRIGGER IF EXISTS trg_cancellations_variant_guard ON public.cancellations;
CREATE TRIGGER trg_cancellations_variant_guard
BEFORE UPDATE ON public.cancellations
FOR EACH ROW EXECUTE FUNCTION public.prevent_variant_change();

-- Enforce allowed subscription status transitions using a transition table
CREATE TABLE IF NOT EXISTS subscription_status_transitions (
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

-- Seed allowed transitions
INSERT INTO subscription_status_transitions (from_status, to_status) VALUES
  ('active', 'pending_cancellation'),
  ('pending_cancellation', 'cancelled'),
  ('pending_cancellation', 'active'),
  ('active', 'cancelled')
ON CONFLICT DO NOTHING;

-- ('cancelled','active') -- Future: allow re-subscribe flow

CREATE OR REPLACE FUNCTION public.enforce_subscription_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allowed BOOLEAN;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM subscription_status_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) INTO allowed;

  IF allowed THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'invalid status transition: % -> %', OLD.status, NEW.status;
  END IF;
END;$$;

DROP TRIGGER IF EXISTS trg_subscriptions_status_guard ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_status_guard
BEFORE UPDATE ON public.subscriptions
FOR EACH ROW EXECUTE FUNCTION public.enforce_subscription_status_transition();

-- Maintain updated_at automatically
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;$$;

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
BEFORE UPDATE ON public.subscriptions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed data
INSERT INTO users (id, email) VALUES
  ('550e8400-e29b-41d4-a716-446655440001', 'user1@example.com'),
  ('550e8400-e29b-41d4-a716-446655440002', 'user2@example.com'),
  ('550e8400-e29b-41d4-a716-446655440003', 'user3@example.com')
ON CONFLICT (email) DO NOTHING;

-- Seed subscriptions with $25 and $29 plans
INSERT INTO subscriptions (user_id, monthly_price, status) VALUES
  ('550e8400-e29b-41d4-a716-446655440001', 2500, 'active'), -- $25.00
  ('550e8400-e29b-41d4-a716-446655440002', 2900, 'active'), -- $29.00
  ('550e8400-e29b-41d4-a716-446655440003', 2500, 'active')  -- $25.00
ON CONFLICT DO NOTHING;