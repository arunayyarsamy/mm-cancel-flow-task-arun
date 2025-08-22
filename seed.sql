-- seed.sql
-- Database schema and seed data for subscription cancellation flow

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
  downsell_variant TEXT CHECK (downsell_variant IN ('A', 'B')),

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

CREATE EXTENSION IF NOT EXISTS pgcrypto;

------------------------------------------------------------------
-- Enable Row Level Security
------------------------------------------------------------------

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellations ENABLE ROW LEVEL SECURITY;

------------------------------------------------------------------
-- Basic RLS policies (hardened)
------------------------------------------------------------------

-- USERS: read own row only
DROP POLICY IF EXISTS "Users can view own data" ON users;
CREATE POLICY "Users can view own data" ON users
  FOR SELECT
  USING (auth.uid() = id);

-- USERS: updates own row only
DROP POLICY IF EXISTS "Users can update own profile" ON users;
CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- SUBSCRIPTIONS: read only own rows
DROP POLICY IF EXISTS "Users can view own subscriptions" ON subscriptions;
CREATE POLICY "Users can view own subscriptions" ON subscriptions
  FOR SELECT
  USING (auth.uid() = user_id);

-- SUBSCRIPTIONS: update only own rows
DROP POLICY IF EXISTS "Users can update own subscriptions" ON subscriptions;
CREATE POLICY "Users can update own subscriptions" ON subscriptions
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- CANCELLATIONS: insert own rows only
DROP POLICY IF EXISTS "Users can insert own cancellations" ON cancellations;
CREATE POLICY "Users can insert own cancellations" ON cancellations
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- CANCELLATIONS: read own rows only
DROP POLICY IF EXISTS "Users can view own cancellations" ON cancellations;
CREATE POLICY "Users can view own cancellations" ON cancellations
  FOR SELECT
  USING (auth.uid() = user_id);

-- CANCELLATIONS: update own rows only
DROP POLICY IF EXISTS "Users can update own cancellations" ON cancellations;
CREATE POLICY "Users can update own cancellations" ON cancellations
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

------------------------------------------------------------------
-- Narrow column exposure for anon via a view (test-friendly, RLS-safe)
------------------------------------------------------------------

-- Exposes only id + email for the user selector; base table remains protected by RLS
CREATE OR REPLACE VIEW public.user_emails_view AS
  SELECT id, email
  FROM public.users;

-- Allow anon to read ONLY from this view (not the base table)
GRANT SELECT ON public.user_emails_view TO anon;
GRANT SELECT ON public.user_emails_view TO authenticated;

------------------------------------------------------------------
-- RPCs with SECURITY DEFINER (minimal set required)
------------------------------------------------------------------

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
SET search_path = public
AS $$
  SELECT s.id, s.user_id, s.status, s.monthly_price, s.created_at
  FROM public.subscriptions s
  WHERE s.user_id = target_user
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.fetch_latest_subscription(uuid) TO anon, authenticated;

-- TEMPORARY: Demo bypass for RLS guard; TODO: Restore strict check for production
CREATE OR REPLACE FUNCTION public.begin_cancellation(p_user_id uuid, p_downsell_variant text)
RETURNS TABLE (cancellation_id uuid, downsell_variant text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_variant text := NULL;
  v_cid uuid;
  v_sub_id uuid;
BEGIN
  -- Demo bypass: allow when no auth (auth.uid() IS NULL). Enforce when signed-in.
  IF v_uid IS NOT NULL AND v_uid <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Pick the latest subscription for the user
  SELECT s.id INTO v_sub_id
  FROM public.subscriptions s
  WHERE s.user_id = p_user_id
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1;

  -- Mark subscription pending (idempotent unless already cancelled)
  UPDATE public.subscriptions
    SET status = CASE WHEN status <> 'cancelled' THEN 'pending_cancellation' ELSE status END
  WHERE id = v_sub_id;

  -- Try to reuse latest cancellation
  SELECT c.id, c.downsell_variant INTO v_cid, v_variant
  FROM public.cancellations c
  WHERE c.user_id = p_user_id
  ORDER BY c.created_at DESC
  LIMIT 1;

  IF v_cid IS NULL THEN
    INSERT INTO public.cancellations (user_id, subscription_id, downsell_variant)
    VALUES (p_user_id, v_sub_id, NULLIF(p_downsell_variant,''))
    RETURNING id, downsell_variant INTO v_cid, v_variant;
  ELSIF v_variant IS NULL AND p_downsell_variant IS NOT NULL THEN
    UPDATE public.cancellations
      SET downsell_variant = p_downsell_variant
    WHERE id = v_cid
    RETURNING downsell_variant INTO v_variant;
  END IF;

  RETURN QUERY SELECT v_cid, v_variant;
END;$$;

GRANT EXECUTE ON FUNCTION public.begin_cancellation(uuid, text) TO anon, authenticated;

-- TEMPORARY: Demo bypass for RLS guard; TODO: Restore strict check for production
CREATE OR REPLACE FUNCTION public.accept_downsell(p_cancellation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user uuid; BEGIN
  SELECT user_id INTO v_user FROM public.cancellations WHERE id = p_cancellation_id;
  -- Demo bypass: only enforce when a user is signed in.
  IF auth.uid() IS NOT NULL AND v_user <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.cancellations SET accepted_downsell = TRUE WHERE id = p_cancellation_id;
END;$$;
GRANT EXECUTE ON FUNCTION public.accept_downsell(uuid) TO anon, authenticated;

-- TEMPORARY: Demo bypass for RLS guard; TODO: Restore strict check for production
CREATE OR REPLACE FUNCTION public.save_found_job_answers(
  p_cancellation_id uuid,
  p_attributed_to_mm boolean,
  p_applied text,
  p_emailed text,
  p_interview text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user uuid; BEGIN
  SELECT user_id INTO v_user FROM public.cancellations WHERE id = p_cancellation_id;
  -- Demo bypass: allow when no auth; enforce match when signed-in
  IF auth.uid() IS NOT NULL AND v_user <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.cancellations
  SET attributed_to_mm = p_attributed_to_mm,
      applied_count   = NULLIF(p_applied,''),
      emailed_count   = NULLIF(p_emailed,''),
      interview_count = NULLIF(p_interview,''),
      reason          = NULLIF(p_reason,'')
  WHERE id = p_cancellation_id;
END;$$;
GRANT EXECUTE ON FUNCTION public.save_found_job_answers(uuid, boolean, text, text, text, text) TO anon, authenticated;

-- TEMPORARY: Demo bypass for RLS guard; TODO: Restore strict check for production
CREATE OR REPLACE FUNCTION public.finalize_found_job(
  p_cancellation_id uuid,
  p_visa_has_lawyer boolean,
  p_visa_type text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user uuid; v_sub uuid; BEGIN
  SELECT user_id, subscription_id INTO v_user, v_sub FROM public.cancellations WHERE id = p_cancellation_id;
  -- Demo bypass: enforce only for signed-in sessions
  IF auth.uid() IS NOT NULL AND v_user <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.cancellations
    SET visa_has_lawyer = p_visa_has_lawyer,
        visa_type       = NULLIF(p_visa_type,'')
  WHERE id = p_cancellation_id;
  UPDATE public.subscriptions SET status = 'cancelled' WHERE id = v_sub;
END;$$;
GRANT EXECUTE ON FUNCTION public.finalize_found_job(uuid, boolean, text) TO anon, authenticated;

-- TEMPORARY: Demo bypass for RLS guard; TODO: Restore strict check for production
CREATE OR REPLACE FUNCTION public.finalize_still_looking(
  p_cancellation_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_user uuid; v_sub uuid; BEGIN
  SELECT user_id, subscription_id INTO v_user, v_sub FROM public.cancellations WHERE id = p_cancellation_id;
  -- Demo bypass: enforce only when authenticated
  IF auth.uid() IS NOT NULL AND v_user <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  UPDATE public.cancellations SET reason = NULLIF(p_reason,'') WHERE id = p_cancellation_id;
  UPDATE public.subscriptions SET status = 'cancelled' WHERE id = v_sub;
END;$$;
GRANT EXECUTE ON FUNCTION public.finalize_still_looking(uuid, text) TO anon, authenticated;

-- TEMPORARY: Demo bypass for RLS guard; TODO: Restore strict check for production
CREATE OR REPLACE FUNCTION public.assign_balanced_downsell(p_user_id uuid)
RETURNS TABLE (cancellation_id uuid, downsell_variant text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_sub_id   uuid;
  v_cid      uuid;
  v_variant  text;
  cnt_a      int;
  cnt_b      int;
  -- stable tie-breaker from user_id
  tiebreak int := (get_byte(decode(md5(p_user_id::text), 'hex'), 0) % 2);
BEGIN
  -- Demo bypass: allow anonymous; enforce when signed-in
  IF v_uid IS NOT NULL AND v_uid <> p_user_id THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- latest subscription
  SELECT s.id INTO v_sub_id
  FROM public.subscriptions AS s
  WHERE s.user_id = p_user_id
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1;

  -- mark pending unless already cancelled
  UPDATE public.subscriptions
     SET status = CASE WHEN status <> 'cancelled' THEN 'pending_cancellation' ELSE status END
   WHERE id = v_sub_id;

  -- reuse latest cancellation if any
  SELECT c.id, c.downsell_variant INTO v_cid, v_variant
  FROM public.cancellations AS c
  WHERE c.user_id = p_user_id
  ORDER BY c.created_at DESC
  LIMIT 1;

  IF v_cid IS NULL THEN
    INSERT INTO public.cancellations (user_id, subscription_id)
    VALUES (p_user_id, v_sub_id)
    RETURNING id INTO v_cid;
  END IF;

  -- assign only once, keeping global balance
  IF v_variant IS NULL THEN
    SELECT
      COUNT(*) FILTER (WHERE c.downsell_variant = 'A')::int,
      COUNT(*) FILTER (WHERE c.downsell_variant = 'B')::int
    INTO cnt_a, cnt_b
    FROM public.cancellations AS c
    WHERE c.downsell_variant IN ('A','B');

    IF cnt_a > cnt_b THEN
      v_variant := 'B';
    ELSIF cnt_b > cnt_a THEN
      v_variant := 'A';
    ELSE
      v_variant := CASE WHEN tiebreak = 0 THEN 'A' ELSE 'B' END;
    END IF;

    UPDATE public.cancellations AS c
       SET downsell_variant = v_variant
     WHERE c.id = v_cid;
  END IF;

  RETURN QUERY SELECT v_cid, v_variant;
END;
$$;

GRANT EXECUTE ON FUNCTION public.assign_balanced_downsell(uuid) TO anon, authenticated;

------------------------------------------------------------------
-- Hardening triggers 
------------------------------------------------------------------

-- Prevent changing downsell_variant after insert
CREATE OR REPLACE FUNCTION public.prevent_variant_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Allow setting variant exactly once if it was previously NULL
    IF OLD.downsell_variant IS NULL AND NEW.downsell_variant IS NOT NULL THEN
      RETURN NEW;
    END IF;
    -- Otherwise, variant is immutable
    IF NEW.downsell_variant IS DISTINCT FROM OLD.downsell_variant THEN
      RAISE EXCEPTION 'downsell_variant is immutable after initial set';
    END IF;
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
  ('550e8400-e29b-41d4-a716-446655440003', 'user3@example.com'),
  ('550e8400-e29b-41d4-a716-446655440004', 'user4@example.com'),
  ('550e8400-e29b-41d4-a716-446655440005', 'user5@example.com'),
  ('550e8400-e29b-41d4-a716-446655440006', 'user6@example.com')
ON CONFLICT (email) DO NOTHING;

-- Seed subscriptions with $25 and $29 plans
INSERT INTO subscriptions (user_id, monthly_price, status) VALUES
  ('550e8400-e29b-41d4-a716-446655440001', 2500, 'active'), -- $25.00
  ('550e8400-e29b-41d4-a716-446655440002', 2900, 'active'), -- $29.00
  ('550e8400-e29b-41d4-a716-446655440003', 2500, 'active'),  -- $25.00
  ('550e8400-e29b-41d4-a716-446655440004', 2900, 'active'), -- $29.00
  ('550e8400-e29b-41d4-a716-446655440005', 2500, 'active'), -- $25.00
  ('550e8400-e29b-41d4-a716-446655440006', 2900, 'active')  -- $29.00
ON CONFLICT DO NOTHING;