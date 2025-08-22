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
  downsell_variant TEXT NOT NULL CHECK (downsell_variant IN ('A', 'B')),
  reason TEXT,
  accepted_downsell BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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
CREATE OR REPLACE VIEW public.user_choices AS
  SELECT id, email
  FROM public.users;

-- Allow anon to read ONLY from this view (not the base table)
GRANT SELECT ON public.user_choices TO anon;

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

-- Enforce allowed subscription status transitions
CREATE OR REPLACE FUNCTION public.enforce_subscription_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'active' AND NEW.status IN ('pending_cancellation','cancelled') THEN
    RETURN NEW;
  ELSIF OLD.status = 'pending_cancellation' AND NEW.status = 'cancelled' THEN
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