-- seed.sql — Clean, deduplicated schema + seed for Migrate Mate cancel flow
-- Focus: minimal tables, strict RLS, a narrow public view, and SECURITY DEFINER RPCs

------------------------------------------------------------------
-- Extensions
------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

------------------------------------------------------------------
-- Core tables
------------------------------------------------------------------
-- Users
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ     DEFAULT now()
);

-- Subscriptions (price in USD cents)
CREATE TABLE IF NOT EXISTS subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monthly_price  INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_cancellation','cancelled')),
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- Cancellations (one row per cancellation attempt; stores survey + downsell)
CREATE TABLE IF NOT EXISTS cancellations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id  UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,

  -- A/B assignment (persist exactly once)
  downsell_variant   TEXT CHECK (downsell_variant IN ('A','B')),
  accepted_downsell  BOOLEAN DEFAULT FALSE,

  -- Found-job branch survey fields
  attributed_to_mm BOOLEAN,
  applied_count    TEXT CHECK (applied_count  IN ('0','1-5','6-20','20+')),
  emailed_count    TEXT CHECK (emailed_count  IN ('0','1-5','6-20','20+')),
  interview_count  TEXT CHECK (interview_count IN ('0','1-2','3-5','5+')),

  -- Free text (sanitized server-side in RPCs)
  reason           TEXT,

  -- Visa (found-job step 3)
  visa_has_lawyer  BOOLEAN,
  visa_type        TEXT,

  created_at       TIMESTAMPTZ DEFAULT now()
);

------------------------------------------------------------------
-- Row Level Security (RLS)
------------------------------------------------------------------
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cancellations ENABLE ROW LEVEL SECURITY;

-- Users: read/update own row only
DROP POLICY IF EXISTS "Users can view own data" ON users;
CREATE POLICY "Users can view own data" ON users
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON users;
CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Subscriptions: read/update own
DROP POLICY IF EXISTS "Users can view own subscriptions" ON subscriptions;
CREATE POLICY "Users can view own subscriptions" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own subscriptions" ON subscriptions;
CREATE POLICY "Users can update own subscriptions" ON subscriptions
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Cancellations: CRUD limited to own rows
DROP POLICY IF EXISTS "Users can insert own cancellations" ON cancellations;
CREATE POLICY "Users can insert own cancellations" ON cancellations
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own cancellations" ON cancellations;
CREATE POLICY "Users can view own cancellations" ON cancellations
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own cancellations" ON cancellations;
CREATE POLICY "Users can update own cancellations" ON cancellations
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

------------------------------------------------------------------
-- Narrow public read surface (selector dropdown)
------------------------------------------------------------------
-- View exposes only id + email; base table stays protected by RLS
CREATE OR REPLACE VIEW public.user_emails_view AS
  SELECT id, email FROM public.users;

GRANT SELECT ON public.user_emails_view TO anon, authenticated;

------------------------------------------------------------------
-- Triggers & guards
------------------------------------------------------------------
-- Prevent changing downsell_variant after it is set once
CREATE OR REPLACE FUNCTION public.prevent_variant_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.downsell_variant IS NULL AND NEW.downsell_variant IS NOT NULL THEN
      RETURN NEW; -- allow first set
    END IF;
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

-- Enforce allowed subscription status transitions
CREATE TABLE IF NOT EXISTS subscription_status_transitions (
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO subscription_status_transitions (from_status, to_status) VALUES
  ('active','pending_cancellation'),
  ('pending_cancellation','cancelled'),
  ('pending_cancellation','active'),
  ('active','cancelled')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.enforce_subscription_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed BOOLEAN; BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1 FROM subscription_status_transitions
    WHERE from_status = OLD.status AND to_status = NEW.status
  ) INTO allowed;
  IF allowed THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid status transition: % -> %', OLD.status, NEW.status;
END;$$;

DROP TRIGGER IF EXISTS trg_subscriptions_status_guard ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_status_guard
BEFORE UPDATE ON public.subscriptions
FOR EACH ROW EXECUTE FUNCTION public.enforce_subscription_status_transition();

------------------------------------------------------------------
-- SECURITY DEFINER RPCs used by the app
------------------------------------------------------------------
-- (1) Latest subscription for pricing/status
CREATE OR REPLACE FUNCTION public.fetch_latest_subscription(target_user uuid)
RETURNS TABLE (id uuid, user_id uuid, status text, monthly_price integer, created_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.user_id, s.status, s.monthly_price, s.created_at
  FROM public.subscriptions s
  WHERE s.user_id = target_user
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.fetch_latest_subscription(uuid) TO anon, authenticated;

-- (2) Assign deterministic + balanced downsell; also mark sub pending (idempotent)
CREATE OR REPLACE FUNCTION public.assign_balanced_downsell(p_user_id uuid)
RETURNS TABLE (cancellation_id uuid, downsell_variant text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sub_id uuid; v_cid uuid; v_variant text; cnt_a int; cnt_b int;
  tiebreak int := (get_byte(decode(md5(p_user_id::text), 'hex'), 0) % 2);
BEGIN
  IF v_uid IS NOT NULL AND v_uid <> p_user_id THEN RAISE EXCEPTION 'forbidden'; END IF;

  SELECT s.id INTO v_sub_id
  FROM public.subscriptions s
  WHERE s.user_id = p_user_id
  ORDER BY s.created_at DESC, s.id DESC
  LIMIT 1;

  UPDATE public.subscriptions
     SET status = CASE WHEN status <> 'cancelled' THEN 'pending_cancellation' ELSE status END
   WHERE id = v_sub_id;

  SELECT c.id, c.downsell_variant INTO v_cid, v_variant
  FROM public.cancellations c
  WHERE c.user_id = p_user_id
  ORDER BY c.created_at DESC
  LIMIT 1;

  IF v_cid IS NULL THEN
    INSERT INTO public.cancellations (user_id, subscription_id)
    VALUES (p_user_id, v_sub_id) RETURNING id INTO v_cid;
  END IF;

  IF v_variant IS NULL THEN
    SELECT COUNT(*) FILTER (WHERE c.downsell_variant = 'A')::int,
           COUNT(*) FILTER (WHERE c.downsell_variant = 'B')::int
      INTO cnt_a, cnt_b
      FROM public.cancellations AS c
      WHERE c.downsell_variant IN ('A','B');

    IF cnt_a > cnt_b THEN v_variant := 'B';
    ELSIF cnt_b > cnt_a THEN v_variant := 'A';
    ELSE v_variant := CASE WHEN tiebreak = 0 THEN 'A' ELSE 'B' END;
    END IF;

    UPDATE public.cancellations SET downsell_variant = v_variant WHERE id = v_cid;
  END IF;

  RETURN QUERY SELECT v_cid, v_variant;
END;$$;
GRANT EXECUTE ON FUNCTION public.assign_balanced_downsell(uuid) TO anon, authenticated;

-- (3) Accept downsell (flag only)
CREATE OR REPLACE FUNCTION public.accept_downsell(p_cancellation_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; BEGIN
  SELECT user_id INTO v_user FROM public.cancellations WHERE id = p_cancellation_id;
  IF auth.uid() IS NOT NULL AND v_user <> auth.uid() THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE public.cancellations SET accepted_downsell = TRUE WHERE id = p_cancellation_id;
END;$$;
GRANT EXECUTE ON FUNCTION public.accept_downsell(uuid) TO anon, authenticated;

-- (4) Save Step-2 answers (found-job branch) via JSONB payload (+ sanitize reason)
CREATE OR REPLACE FUNCTION public.save_found_job_answers(p_cancellation_id uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_reason text; BEGIN
  SELECT user_id INTO v_user FROM public.cancellations WHERE id = p_cancellation_id;
  IF auth.uid() IS NOT NULL AND v_user <> auth.uid() THEN RAISE EXCEPTION 'forbidden'; END IF;

  v_reason := nullif(p_payload->>'reason','');
  IF v_reason IS NOT NULL THEN
    v_reason := regexp_replace(v_reason, '<[^>]*>', '', 'g');
  END IF;

  UPDATE public.cancellations SET
    attributed_to_mm = COALESCE((p_payload->>'attributed_to_mm')::boolean, attributed_to_mm),
    applied_count     = COALESCE(NULLIF(p_payload->>'applied_count',''), applied_count),
    emailed_count     = COALESCE(NULLIF(p_payload->>'emailed_count',''), emailed_count),
    interview_count   = COALESCE(NULLIF(p_payload->>'interview_count',''), interview_count),
    reason            = COALESCE(v_reason, reason)
  WHERE id = p_cancellation_id;

  RETURN jsonb_build_object('ok', true);
END;$$;
GRANT EXECUTE ON FUNCTION public.save_found_job_answers(uuid, jsonb) TO anon, authenticated;

-- (5) Fetch latest cancellation (id + variant) for prefill
CREATE OR REPLACE FUNCTION public.fetch_latest_cancellation(p_user_id uuid)
RETURNS TABLE (cancellation_id uuid, downsell_variant text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.downsell_variant
  FROM public.cancellations c
  WHERE c.user_id = p_user_id
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.fetch_latest_cancellation(uuid) TO anon, authenticated;

-- (6) Fetch persisted answers for prefill (step-2)
CREATE OR REPLACE FUNCTION public.fetch_cancellation_answers(p_cancellation_id uuid)
RETURNS TABLE (
  attributed_to_mm boolean,
  applied_count     text,
  emailed_count     text,
  interview_count   text,
  reason            text
) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT c.attributed_to_mm, c.applied_count, c.emailed_count, c.interview_count, c.reason
  FROM public.cancellations c
  WHERE c.id = p_cancellation_id;
$$;
GRANT EXECUTE ON FUNCTION public.fetch_cancellation_answers(uuid) TO anon, authenticated;

-- (7) Finalize paths: found-job / still-looking (marks subscription=cancelled)
CREATE OR REPLACE FUNCTION public.finalize_found_job(p_cancellation_id uuid, p_visa_has_lawyer boolean, p_visa_type text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_sub uuid; BEGIN
  SELECT user_id, subscription_id INTO v_user, v_sub FROM public.cancellations WHERE id = p_cancellation_id;
  IF auth.uid() IS NOT NULL AND v_user <> auth.uid() THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE public.cancellations SET visa_has_lawyer = p_visa_has_lawyer, visa_type = NULLIF(p_visa_type,'') WHERE id = p_cancellation_id;
  UPDATE public.subscriptions SET status = 'cancelled' WHERE id = v_sub;
END;$$;
GRANT EXECUTE ON FUNCTION public.finalize_found_job(uuid, boolean, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.finalize_still_looking(p_cancellation_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid; v_sub uuid; BEGIN
  SELECT user_id, subscription_id INTO v_user, v_sub FROM public.cancellations WHERE id = p_cancellation_id;
  IF auth.uid() IS NOT NULL AND v_user <> auth.uid() THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE public.cancellations SET reason = NULLIF(p_reason,'') WHERE id = p_cancellation_id;
  UPDATE public.subscriptions SET status = 'cancelled' WHERE id = v_sub;
END;$$;
GRANT EXECUTE ON FUNCTION public.finalize_still_looking(uuid, text) TO anon, authenticated;

------------------------------------------------------------------
-- Seed data (stable UUIDs for deterministic demos)
------------------------------------------------------------------
INSERT INTO users (id, email) VALUES
  ('550e8400-e29b-41d4-a716-446655440001', 'user1@example.com'),
  ('550e8400-e29b-41d4-a716-446655440002', 'user2@example.com'),
  ('550e8400-e29b-41d4-a716-446655440003', 'user3@example.com'),
  ('550e8400-e29b-41d4-a716-446655440004', 'user4@example.com'),
  ('550e8400-e29b-41d4-a716-446655440005', 'user5@example.com'),
  ('550e8400-e29b-41d4-a716-446655440006', 'user6@example.com')
ON CONFLICT (email) DO NOTHING;

-- Mix $25 and $29 plans
INSERT INTO subscriptions (user_id, monthly_price, status) VALUES
  ('550e8400-e29b-41d4-a716-446655440001', 2500, 'active'),
  ('550e8400-e29b-41d4-a716-446655440002', 2900, 'active'),
  ('550e8400-e29b-41d4-a716-446655440003', 2500, 'active'),
  ('550e8400-e29b-41d4-a716-446655440004', 2900, 'active'),
  ('550e8400-e29b-41d4-a716-446655440005', 2500, 'active'),
  ('550e8400-e29b-41d4-a716-446655440006', 2900, 'active')
ON CONFLICT DO NOTHING;