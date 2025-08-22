# Submission Summary — Migrate Mate Cancellation Flow

**Stack**: Next.js (App Router) + TypeScript + Tailwind + Supabase (Postgres + RLS)

## Architecture & Flow
- `CancellationModal` orchestrates a 3-step progressive journey with two branches:
  - **Found job**: congrats → attribution + usage questions → open visa helper → completion
  - **Still looking**: optional downsell screen (Variant B) → usage → reason → completion
- The modal is responsive (mobile/desktop), locks background scroll, and matches Figma spacing/typography with a shared `COLORS` palette (no inline hex).

## A/B Test (Deterministic 50/50)
- On first entry, the client calls a Supabase RPC that:
  1) Ensures (or creates) an open `cancellations` row for the user
  2) Assigns a **single** downsell variant using a secure RNG, persisted to `cancellations.downsell_variant`
- On subsequent entries the stored variant is reused (no re-randomization).
- Variant B shows **$10 off** (e.g., $25→$15, $29→$19). Pricing is computed from `monthly_price_cents` and rendered everywhere it appears.

## Why a balanced deterministic allocator (vs. pure RNG)
- **Fair but not balanced**: A cryptographically secure RNG is unbiased, but small cohorts can skew (e.g., 60/40) just by chance. The README requires a 50/50 split and practical parity between groups.
- **Deterministic + minority-biased**: We assign on first entry by checking current counts in DB and giving the **minority** variant (tie → secure RNG). This keeps groups **near-perfectly balanced at all times**, not just “in expectation.”
- **Persistence**: The assigned variant is stored on the user’s open cancellation row and **reused** on return visits—no re-randomization, no drift.
- **Race-safety**: The assignment happens server-side in an RPC/transaction, avoiding concurrent skew.

## Data Persistence
- `subscriptions.status` is moved to `pending_cancellation` at the start of the journey (consistent with README).
- `cancellations` captures: `user_id`, `downsell_variant`, `accepted_downsell`, `reason`, timestamps, and structured answers from both branches (attribution, applied/emailed/interviews, visa fields).
- All writes happen via parameterized supabase-js calls or RPCs.

## Security
- **RLS**: users can only read/update their own rows; mutation helpers and SECURE functions are used to keep logic server-side.
- **Input validation/XSS**:
  - Client: all free-text inputs pass through a sanitizer (`sanitizeText`) that strips tags, dangerous schemes, normalizes whitespace, and clamps length.
- **CSRF**: The app calls Supabase directly with anon keys (no cookie session), minimizing CSRF risk. As defense-in-depth we add a **CSP** header via `src/middleware.ts`. In dev, CSP allows `'unsafe-eval'` for Next tooling; in prod it is stricter.
- **No dangerouslySetInnerHTML** is used; React’s default escaping applies.


## Setup

1. Clone repo & install:  
   ```bash
   git clone <repo-url>
   cd mm-cancel-flow-task-arun
   npm install
   ```

2. Start local Supabase & seed DB:  
   ```bash
   npm run db:setup
   ```

3. Create `.env.local` with:
   ```
   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   ```

4. Run dev server:  
   ```bash
   npm run dev
   # open http://localhost:3000
   ```

5. Use dropdown to pick a test user and go through cancellation flow.

## Test UX: user dropdown
- For evaluation convenience, I added a **read-only user dropdown** so reviewers can impersonate a seeded user and walk through the flow without implementing full auth.
- This control reads from a minimal view (no PII beyond email/id) and only for seeded users. In production we would remove it and derive the active user from auth.

## Least-privilege exposure via Postgres views
- To avoid exposing full `users` rows, the UI reads from a **whitelisted view** (e.g., `public.user_emails_view`) that projects only `id,email`.
- RLS still applies on base tables; the view limits what columns are even visible to the anon client.
- This lets the demo remain functional (select a user) while respecting **principle of least privilege**.

## Notes & Tradeoffs
- The downsell price uses the current plan’s cents → dollars, minus $10, never below $0.
- Payment processing is intentionally stubbed (out of scope).
- For evaluation convenience there is a user-selection dropdown (read-only view) controlled by tight RLS or a view; in a real app we’d use the authenticated user identity only.
- CSS colors are centralized in `COLORS` for consistency and easier theming.
- The completion screens differ by branch and visa selection per Figma.

## Testing
- A/B determinism verified by repeated entries (variant persists).
- XSS tests with `<script>`/`javascript:` strings are neutralized in the UI and sanitized in DB.
- CSP verified in dev and production modes.