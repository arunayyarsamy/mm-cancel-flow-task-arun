/**
 * CancellationModal
 * Single, self-contained flow for subscription cancellation with a simple A/B downsell.
 * Keeps logic local, calls RLS-safe RPC helpers from lib/supabase, and debounces autosaves.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { assignBalancedDownsell, saveFoundJobAnswersRpc, acceptDownsell, finalizeFoundJob, finalizeStillLooking, fetchLatestCancellationForUser, fetchCancellationAnswers } from '@/lib/supabase';

const COLORS = {
  brand: '#8952fc',
  brandStrong: '#7b40fc',
  accent: '#6b4eff',
  cardBg: '#efe7ff',
  success: '#35b34a',
  successStrong: '#2ea743',
  danger: "#e22525",
  dangerStrong: '#dc2626',
  textPrimary: '#111827',
  textSecondary: '#374151',
  textMuted: '#6B7280',
  border: '#D1D5DB',
  borderLight: '#E5E7EB',
  bgWhite: '#FFFFFF',
  bgMuted: '#F9FAFB',
  overlay: 'rgba(0,0,0,0.60)',
  textOnBrand: '#FFFFFF',
  error: '#F87171',
  progressDone: '#22c55e',
  progressCurrent: '#9CA3AF',
  progressTodo: '#E5E7EB'
};

// ────────────────────────────────────────────────────────────────────────────────
// Sanitize & debounce utilities
// ────────────────────────────────────────────────────────────────────────────────

const MAX_TEXT_LEN = 1000;
/**
 * Strip tags, neutralize unsafe schemes, collapse whitespace, and clamp length.
 * Server will sanitize again, but this keeps the UI tidy and safe.
 */
function sanitizeText(input: string): string {
  if (!input) return '';
  // Remove HTML tags
  const noTags = input.replace(/<[^>]*>/g, '');
  // Neutralize common URL/script vectors
  const noSchemes = noTags.replace(/javascript:/gi, '').replace(/data:text\/html/gi, '');
  // Collapse whitespace & trim, clamp length
  return noSchemes.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN);
}

// --- Debounce utility ---
function debounce<F extends (...args: any[]) => void>(fn: F, wait = 500) {
  let t: any;
  return (...args: Parameters<F>) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// Linear flow with a detour for variant B (downsell). Steps drive the left panel content.

type CancellationStep = 'initial' | 'job-status' | 'downsell' | 'downsell-accepted' | 'using' | 'reasons' | 'feedback' | 'confirmation' | 'completed';

interface CancellationModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  monthlyPriceCents?: number;
}

export default function CancellationModal({ isOpen, onClose, userId, monthlyPriceCents }: CancellationModalProps) {
  const [currentStep, setCurrentStep] = useState<CancellationStep>('initial');
  const [selectedOption, setSelectedOption] = useState<'found-job' | 'still-looking' | null>(null);
  const [feedback, setFeedback] = useState('');
  const [attributedToMM, setAttributedToMM] = useState<boolean | null>(null);
  const [appliedCount, setAppliedCount] = useState<'0' | '1-5' | '6-20' | '20+' | ''>('');
  const [emailedCount, setEmailedCount] = useState<'0' | '1-5' | '6-20' | '20+' | ''>('');
  const [interviewCount, setInterviewCount] = useState<'0' | '1-2' | '3-5' | '5+' | ''>('');
  const [visaHasLawyer, setVisaHasLawyer] = useState<boolean | null>(null);
  const [visaType, setVisaType] = useState('');
  const [reasonChoice, setReasonChoice] = useState<null | 'too_expensive' | 'not_helpful' | 'not_enough_jobs' | 'decided_not_to_move' | 'other'>(null);
  const [reasonText, setReasonText] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  // Deterministic downsell (A/B) for users who are still looking
  const [downsellVariant, setDownsellVariant] = useState<'A' | 'B' | null>(null);
  const [acceptedDownsell, setAcceptedDownsell] = useState<boolean>(false);
  const [cancellationId, setCancellationId] = useState<string | null>(null);
  const [abLoading, setAbLoading] = useState<boolean>(false);

  // --- Pricing helpers for $10 off variant (README requirement) ---
  function formatMoney(n: number): string {
    // show no decimals for whole dollars, else 2 decimals
    return Number.isInteger(n) ? n.toString() : n.toFixed(2);
  }
  const BASE_PRICE_DOLLARS = typeof monthlyPriceCents === 'number' ? Math.max(0, Math.round(monthlyPriceCents) / 100) : 25;
  const DISCOUNTED_PRICE_DOLLARS = Math.max(0, BASE_PRICE_DOLLARS - 10);

  const [hoverDownsellCTA, setHoverDownsellCTA] = useState(false);
  const [hoverFeedbackContinue, setHoverFeedbackContinue] = useState(false);
  const [hoverFinish1, setHoverFinish1] = useState(false);
  const [hoverFinish2, setHoverFinish2] = useState(false);
  const [hoverDownsellAcceptedCTA, setHoverDownsellAcceptedCTA] = useState(false);
  // Add hover states for initial Yes/No, job continue, complete cancel
  const [hoverInitYes, setHoverInitYes] = useState(false);
  const [hoverInitNo, setHoverInitNo] = useState(false);
  const [hoverJobContinue, setHoverJobContinue] = useState(false);
  const [hoverCompleteCancel, setHoverCompleteCancel] = useState(false);
  const [hoverUsingContinue, setHoverUsingContinue] = useState(false);
  const [hoverNoThanks, setHoverNoThanks] = useState(false);

  const MIN_FEEDBACK = 25;
  const [feedbackTouched, setFeedbackTouched] = useState(false);

  const scrollYRef = useRef(0);

  const totalSteps = 3;
  const getStepNumber = () => {
    switch (currentStep) {
      case 'job-status':
      case 'downsell':
        return 1;
      case 'using':
        return 2;
      case 'reasons':
        return 3;
      case 'feedback':
        return 2;
      case 'confirmation':
        return 3;
      default:
        return 0; // initial has no number
    }
  };

  const handleBack = () => {
    if (currentStep === 'using') {
      if (downsellVariant === 'B' && !acceptedDownsell) setCurrentStep('downsell');
      else setCurrentStep('initial');
      return;
    }
    if (currentStep === 'job-status') {
      setCurrentStep('initial');
    } else if (currentStep === 'feedback') {
      // if the user came from found-job, go back to job-status; otherwise to initial
      if (selectedOption === 'found-job') setCurrentStep('job-status');
      else setCurrentStep('initial');
    } else if (currentStep === 'downsell') {
      setCurrentStep('initial');
    } else if (currentStep === 'reasons') {
      setCurrentStep('using');
    } else if (currentStep === 'downsell-accepted') {
      // after accepting offer, treat as terminal or go back to downsell if you prefer
      setCurrentStep('downsell');
    } else if (currentStep === 'confirmation') {
      setCurrentStep('feedback');
    }
  };

  // Best-effort prefill from persisted cancellation draft; unknown/missing fields are ignored.
  function prefillFromCancellation(row: any) {
    if (!row || typeof row !== 'object') return;
    // attributed_to_mm: boolean|null
    if ('attributed_to_mm' in row && (row.attributed_to_mm === true || row.attributed_to_mm === false || row.attributed_to_mm === null)) {
      setAttributedToMM(row.attributed_to_mm);
    }
    // applied_count: '0'|'1-5'|'6-20'|'20+'|''
    const appliedOpts = ['0', '1-5', '6-20', '20+'];
    if ('applied_count' in row && typeof row.applied_count === 'string' && appliedOpts.includes(row.applied_count)) {
      setAppliedCount(row.applied_count as '0'|'1-5'|'6-20'|'20+');
    }
    // emailed_count: '0'|'1-5'|'6-20'|'20+'|''
    if ('emailed_count' in row && typeof row.emailed_count === 'string' && appliedOpts.includes(row.emailed_count)) {
      setEmailedCount(row.emailed_count as '0'|'1-5'|'6-20'|'20+');
    }
    // interview_count: '0'|'1-2'|'3-5'|'5+'|''
    const interviewOpts = ['0', '1-2', '3-5', '5+'];
    if ('interview_count' in row && typeof row.interview_count === 'string' && interviewOpts.includes(row.interview_count)) {
      setInterviewCount(row.interview_count as '0'|'1-2'|'3-5'|'5+');
    }
    // accepted_downsell: boolean
    if ('accepted_downsell' in row && (row.accepted_downsell === true || row.accepted_downsell === false)) {
      setAcceptedDownsell(row.accepted_downsell);
    }
    // reason (used by both flows)
    if ('reason' in row && typeof row.reason === 'string') {
      const r = sanitizeText(row.reason);
      // Found‑job step uses `feedback` textarea; still‑looking uses `reasonText`
      setFeedback(r);
      setReasonText(r);
    }
    // visa_has_lawyer: boolean|null
    if ('visa_has_lawyer' in row && (row.visa_has_lawyer === true || row.visa_has_lawyer === false || row.visa_has_lawyer === null)) {
      setVisaHasLawyer(row.visa_has_lawyer);
    }
    // visa_type: string
    if ('visa_type' in row && typeof row.visa_type === 'string') {
      setVisaType(row.visa_type);
    }
    // downsell_variant: 'A'|'B'|null
    if ('downsell_variant' in row && (row.downsell_variant === 'A' || row.downsell_variant === 'B')) {
      setDownsellVariant(row.downsell_variant);
    }
    // You can add more fields as needed, ignoring unknown/missing.
  }

  // Prefill most recent cancellation + answers when the modal opens, to resume drafts.
  useEffect(() => {
    if (!isOpen || !userId) return;
    (async () => {
      try {
        const latest = await fetchLatestCancellationForUser(userId);

        // Handle both array and object shapes returned by the RPC
        const latestRow: any = Array.isArray(latest)
          ? latest[0]
          : (latest && typeof latest === 'object' ? latest : null);

        if (latestRow) {
          // Accept either `id` or `cancellation_id`
          const cid = latestRow.id ?? latestRow.cancellation_id ?? null;
          setCancellationId(cid);

          const variant = latestRow.downsell_variant ?? latestRow.downsellVariant;
          if (variant === 'A' || variant === 'B') setDownsellVariant(variant);

          // Prefill from the main row
          prefillFromCancellation(latestRow);

          // Also hydrate from the answers helper using the cancellation id
          if (cid) {
            const ans = await fetchCancellationAnswers(cid);
            const ansRow: any = Array.isArray(ans)
              ? ans[0]
              : (ans && typeof ans === 'object' ? ans : null);
            if (ansRow) prefillFromCancellation(ansRow);
          }
        }
      } catch (err) {
        console.error('Failed to fetch latest cancellation/answers', err);
      }
    })();
  }, [isOpen, userId]);

  // On entering the "using" step, re-fetch answers to keep UI in sync with autosave.
  useEffect(() => {
    if (!cancellationId) return;
    if (currentStep !== 'using') return;
    (async () => {
      try {
        const ans = await fetchCancellationAnswers(cancellationId);
        const ansRow: any =
          Array.isArray(ans) ? ans[0] :
          (ans && typeof ans === 'object' ? ans : null);
        if (ansRow) prefillFromCancellation(ansRow);
      } catch (err) {
        console.error('Failed to refresh persisted draft for using step', err);
      }
    })();
  }, [cancellationId, currentStep]);

  // Kick off the flow. If we already have a cancellation + variant, reuse it.
  const handleOptionSelect = async (option: 'found-job' | 'still-looking') => {
    setSelectedOption(option);
    if (!userId) {
      console.error('No userId provided to CancellationModal; aborting flow start.');
      return;
    }

    // If we already have a cancellation row + variant from prefill, reuse it
    // so previously-saved answers can preselect the UI. Avoid creating a new row.
    if (cancellationId && (downsellVariant === 'A' || downsellVariant === 'B')) {
      if (option === 'found-job') {
        setCurrentStep('job-status');
      } else {
        setCurrentStep(downsellVariant === 'B' ? 'downsell' : 'using');
      }
      return;
    }

    try {
      setAbLoading(true);
      // Ensure/reuse open cancellation and assign balanced A/B server-side
      const res = await assignBalancedDownsell(userId);
      const cid = res.cancellation_id as string;
      const variant = (res.downsell_variant === 'A' || res.downsell_variant === 'B') ? res.downsell_variant : null;
      setCancellationId(cid);
      setDownsellVariant(variant);
      prefillFromCancellation(res);
      if (option === 'found-job') {
        setCurrentStep('job-status');
      } else {
        // still-looking
        setCurrentStep(variant === 'B' ? 'downsell' : 'using');
      }
    } catch (e) {
      console.error('Failed to ensure cancellation row / assign variant', e);
    } finally {
      setAbLoading(false);
    }
  };

  const handleFeedbackSubmit = async () => {
    try {
      // Persist step 1+2 answers only for found-job branch
      if (selectedOption === 'found-job' && cancellationId) {
        const trimmed = sanitizeText(feedback);
        await saveFoundJobAnswersRpc(cancellationId, {
          attributed_to_mm: (attributedToMM ?? null),
          applied_count: (appliedCount ?? '') as '' | '0' | '1-5' | '6-20' | '20+',
          emailed_count: (emailedCount ?? '') as '' | '0' | '1-5' | '6-20' | '20+',
          interview_count: (interviewCount ?? '') as '' | '0' | '1-2' | '3-5' | '5+',
          reason: trimmed.length > 0 ? trimmed : undefined,
        });
      }
    } catch (e) {
      console.error('Failed to persist feedback/answers', e);
    }
    // Go to Step 3 and keep the modal open until the user completes cancellation
    setCurrentStep('confirmation');
  };

  const resetModal = () => {
    setCurrentStep('initial');
    setSelectedOption(null);
    setFeedback('');
    setAttributedToMM(null);
    setAppliedCount('');
    setEmailedCount('');
    setInterviewCount('');
    setVisaHasLawyer(null);
    setVisaType('');
    setDownsellVariant(null);
    setAcceptedDownsell(false);
    setCancellationId(null);
    setAbLoading(false);
    setReasonChoice(null);
    setReasonText('');
    setMaxPrice('');
    setReasonTouched(false);
  };


  // Single source of truth for draft payloads across autosave and explicit saves.
  // Build JSONB payload for autosave across steps; server sanitizes again on write.
  function buildDraftPayload() {
    const payload: any = {};
    if (attributedToMM === true || attributedToMM === false) payload.attributed_to_mm = attributedToMM;
    if (appliedCount) payload.applied_count = appliedCount;
    if (emailedCount) payload.emailed_count = emailedCount;
    if (interviewCount) payload.interview_count = interviewCount;
    if (downsellVariant === 'A' || downsellVariant === 'B') payload.downsell_variant = downsellVariant;
    if (acceptedDownsell === true || acceptedDownsell === false) payload.accepted_downsell = acceptedDownsell;
    if (visaHasLawyer === true || visaHasLawyer === false) payload.visa_has_lawyer = visaHasLawyer;
    if (visaType) payload.visa_type = sanitizeText(visaType);
    // Save reason as a draft as well; final step will overwrite/confirm as needed
    if (reasonChoice) {
      if (reasonChoice === 'too_expensive') {
        payload.reason = sanitizeText(maxPrice ? `Too expensive; willing to pay $${maxPrice}` : 'Too expensive');
      } else if (reasonText) {
        payload.reason = sanitizeText(reasonText);
      }
    }
    return payload;
  }

 // Debounced autosave to avoid excessive writes while the user types.
  const debouncedSaveDraft = useRef(
    debounce(async (cid: string, data: any) => {
      try {
        await saveFoundJobAnswersRpc(cid, data);
      } catch (e) {
        console.error('autosave draft failed', e);
      }
    }, 600)
  ).current;

  // --- Autosave effect: persist draft on any relevant change ---
  useEffect(() => {
    if (!cancellationId) return;
    const payload = buildDraftPayload();
    if (Object.keys(payload).length === 0) return;
    debouncedSaveDraft(cancellationId, payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    cancellationId,
    attributedToMM,
    appliedCount,
    emailedCount,
    interviewCount,
    downsellVariant,
    acceptedDownsell,
    reasonChoice,
    reasonText,
    maxPrice,
    visaHasLawyer,
    visaType
  ]);

  const handleClose = async () => {
    // Best-effort explicit save on close using shared payload
    if (cancellationId) {
      const payload = buildDraftPayload();
      if (Object.keys(payload).length) {
        try { await saveFoundJobAnswersRpc(cancellationId, payload); } catch {}
      }
    }
    onClose();
    resetModal();
  };

  // Lock background scroll when modal is open (desktop + mobile/iOS safe)
  useEffect(() => {
    if (!isOpen) return;

    // Save current scroll position
    scrollYRef.current = window.scrollY || window.pageYOffset;

    // Apply body lock
    const body = document.body;
    const html = document.documentElement;

    // Prevent overscroll/bounce on iOS
    html.style.overscrollBehavior = 'none';

    // Lock the body in place without visual jump
    body.style.position = 'fixed';
    body.style.top = `-${scrollYRef.current}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    body.style.overflow = 'hidden';

    return () => {
      // Restore styles
      body.style.position = '';
      body.style.top = '';
      body.style.left = '';
      body.style.right = '';
      body.style.width = '';
      body.style.overflow = '';
      html.style.overscrollBehavior = '';

      // Restore scroll position
      window.scrollTo({ top: scrollYRef.current });
    };
  }, [isOpen]);

  type SegmentValue = '0' | '1-5' | '6-20' | '20+' | '1-2' | '3-5' | '5+' | '';
  const Segments = ({ options, value, onChange }: { options: SegmentValue[]; value: SegmentValue; onChange: (v: SegmentValue) => void; }) => (
    <div className="grid grid-cols-4 gap-3">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={'rounded-lg border px-3 py-2 text-sm font-medium transition'}
          style={
            String(value) === String(opt)
              ? { borderColor: COLORS.brand, backgroundColor: COLORS.brand, color: '#fff' }
              : { borderColor: '#D1D5DB', backgroundColor: '#fff', color: '#374151' }
          }
        >
          {opt}
        </button>
      ))}
    </div>
  );

  // ────────────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────────────

  if (!isOpen) return null;

  // Show back button on all steps except initial, completed, downsell-accepted
  const showBack = !['initial','completed','downsell-accepted'].includes(currentStep);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ backgroundColor: COLORS.overlay }}
    >
      <div
        className="rounded-2xl shadow-2xl max-w-4xl w-full overflow-hidden"
        style={{ backgroundColor: COLORS.bgWhite }}
      >
        {/* Header */}
        <div
          className="px-4 py-3 border-b"
          style={{ borderColor: COLORS.borderLight, borderBottomWidth: 1, borderStyle: 'solid' }}
        >
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
            {/* Back (left) */}
            {showBack ? (
              <button
                onClick={handleBack}
                aria-label="Back"
                className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors"
                style={{ color: COLORS.textSecondary }}
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
                <span className="text-sm font-medium">Back</span>
              </button>
            ) : (
              <span className="h-5 w-5"/>
            )}

            {/* Title + progress (center) */}
            <div className="flex flex-col md:flex-row items-center justify-center gap-1 md:gap-3">
              <p
                className="text-[16px] md:text-[17px] font-medium"
                style={{ color: COLORS.textPrimary }}
              >
                {currentStep === 'completed'
                  ? 'Subscription Cancelled'
                  : currentStep === 'downsell-accepted'
                    ? 'Subscription'
                    : 'Subscription Cancellation'}
              </p>
              {(currentStep === 'job-status' || currentStep === 'downsell' || currentStep === 'using' || currentStep === 'feedback' || currentStep === 'confirmation' || currentStep === 'completed' || currentStep === 'reasons') && (
                <div className="mt-1 md:mt-0 flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    {[1, 2, 3].map((n) => {
                      const step = getStepNumber();
                      let color;
                      if (currentStep === 'completed' || step > n) {
                        color = COLORS.progressDone;
                      } else if (step === n) {
                        color = COLORS.progressCurrent;
                      } else {
                        color = COLORS.progressTodo;
                      }
                      return (
                        <span
                          key={n}
                          className="h-1.5 w-4 md:h-2 md:w-5 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                      );
                    })}
                  </div>
                  <span
                    className="text-[11px] md:text-xs"
                    style={{ color: COLORS.textMuted }}
                  >
                    {currentStep === 'completed' ? 'Completed' : `Step ${getStepNumber()} of ${totalSteps}`}
                  </span>
                </div>
              )}
            </div>

            {/* Close (right) */}
            <button
              onClick={handleClose}
              className="justify-self-end rounded-md p-1.5 transition-colors"
              aria-label="Close modal"
              style={{ color: COLORS.textMuted }}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="grid grid-cols-1 md:grid-cols-[65%_35%] items-stretch">
          {/* Left Panel - Text Content */}
          <div
            className={`order-2 md:order-1 px-5 md:px-6 ${currentStep==='downsell-accepted' ? 'py-4 md:py-6' : 'py-5'} flex flex-col ${currentStep==='downsell-accepted' ? 'justify-between' : 'justify-center'}`}
            style={{ backgroundColor: COLORS.bgWhite }}
          >
            <div>
              {currentStep === 'initial' && (
                <>
                  <h3
                    className="text-[26px] md:text-[32px] font-extrabold leading-tight tracking-[-0.01em] mb-2"
                    style={{ color: COLORS.textPrimary }}
                  >
                    Hey mate,<br/>Quick one before you go.
                  </h3>
                  
                  <h4
                    className="text-[22px] md:text-[26px] italic font-semibold mb-4"
                    style={{ color: COLORS.textPrimary }}
                  >
                    Have you found a job yet?
                  </h4>
                  
                  <p
                    className="text-[15px] md:text-[16px] leading-relaxed mb-4"
                    style={{ color: COLORS.textMuted }}
                  >
                    Whatever your answer, we just want to help you take the next step.
                    With visa support, or by hearing how we can do better.
                  </p>
                  <hr
                    className="my-5 border-t"
                    style={{ borderColor: COLORS.borderLight, borderTopWidth: 1, borderStyle: 'solid' }}
                  />
                  <div className="space-y-4">
                    <button
                      onClick={() => handleOptionSelect('found-job')}
                      disabled={abLoading}
                      className={
                        "w-full select-none touch-manipulation rounded-2xl border px-4 py-3 text-[15px] font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 " +
                        (hoverInitYes ? "" : "") +
                        (abLoading ? ' opacity-60 cursor-wait' : '')
                      }
                      style={
                        hoverInitYes
                          ? { backgroundColor: COLORS.brand, borderColor: COLORS.brand, color: COLORS.textOnBrand }
                          : { backgroundColor: COLORS.bgWhite, borderColor: COLORS.border, color: COLORS.textSecondary }
                      }
                      onMouseEnter={() => setHoverInitYes(true)}
                      onMouseLeave={() => setHoverInitYes(false)}
                    >
                      Yes, I’ve found a job
                    </button>

                    <button
                      onClick={() => handleOptionSelect('still-looking')}
                      disabled={abLoading}
                      className={
                        "w-full select-none touch-manipulation rounded-2xl border px-4 py-3 text-[15px] font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 " +
                        (hoverInitNo ? "" : "") +
                        (abLoading ? ' opacity-60 cursor-wait' : '')
                      }
                      style={
                        hoverInitNo
                          ? { backgroundColor: COLORS.brand, borderColor: COLORS.brand, color: COLORS.textOnBrand }
                          : { backgroundColor: COLORS.bgWhite, borderColor: COLORS.border, color: COLORS.textSecondary }
                      }
                      onMouseEnter={() => setHoverInitNo(true)}
                      onMouseLeave={() => setHoverInitNo(false)}
                    >
                      Not yet – I’m still looking
                    </button>
                  </div>
                </>
              )}

              {currentStep === 'job-status' && (
                <>
                  <h3
                    className="text-xl md:text-2xl font-bold mb-2"
                    style={{ color: COLORS.textPrimary }}
                  >
                    Congrats on the new role! 🎉
                  </h3>

                  <div className="space-y-5">
                    <div>
                      <p
                        className="text-sm font-medium mb-2"
                        style={{ color: COLORS.textSecondary }}
                      >
                        Did you find this job with Migrate Mate?*
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setAttributedToMM(true)}
                          className="rounded-lg border px-4 py-2 text-sm font-medium transition"
                          style={
                            attributedToMM === true
                              ? { borderColor: COLORS.brand, backgroundColor: COLORS.brand, color: '#fff' }
                              : { borderColor: '#D1D5DB', backgroundColor: '#fff', color: '#374151' }
                          }
                        >
                          Yes
                        </button>
                        <button
                          type="button"
                          onClick={() => setAttributedToMM(false)}
                          className="rounded-lg border px-4 py-2 text-sm font-medium transition"
                          style={
                            attributedToMM === false
                              ? { borderColor: COLORS.brand, backgroundColor: COLORS.brand, color: '#fff' }
                              : { borderColor: '#D1D5DB', backgroundColor: '#fff', color: '#374151' }
                          }
                        >
                          No
                        </button>
                      </div>
                    </div>

                    <div>
                      <p
                        className="text-sm font-medium mb-2"
                        style={{ color: COLORS.textSecondary }}
                      >
                        How many roles did you <span className='underline'>apply</span> for through Migrate Mate?*
                      </p>
                      <Segments options={['0','1-5','6-20','20+']} value={appliedCount} onChange={(v)=>setAppliedCount(v as typeof appliedCount)} />
                    </div>

                    <div>
                      <p
                        className="text-sm font-medium mb-2"
                        style={{ color: COLORS.textSecondary }}
                      >
                        How many companies did you <span className='underline'>email</span> directly?*
                      </p>
                      <Segments options={['0','1-5','6-20','20+']} value={emailedCount} onChange={(v)=>setEmailedCount(v as typeof emailedCount)} />
                    </div>

                    <div>
                      <p
                        className="text-sm font-medium mb-2"
                        style={{ color: COLORS.textSecondary }}
                      >
                        How many different companies did you <span className='underline'>interview</span> with?*
                      </p>
                      <Segments options={['0','1-2','3-5','5+']} value={interviewCount} onChange={(v)=>setInterviewCount(v as typeof interviewCount)} />
                    </div>

                    <div className="pt-2">
                      <button
                        onClick={async () => {
                          // Explicit save using the shared payload builder before advancing
                          if (cancellationId) {
                            const payload = buildDraftPayload();
                            if (Object.keys(payload).length) {
                              try { await saveFoundJobAnswersRpc(cancellationId, payload); } catch (e) { /* optional debug */ }
                            }
                          }
                          setCurrentStep('feedback');
                        }}
                        disabled={
                          attributedToMM === null || !appliedCount || !emailedCount || !interviewCount
                        }
                        className={
                          'w-full rounded-2xl py-3 text-[15px] font-semibold transition-colors ' +
                          (attributedToMM === null || !appliedCount || !emailedCount || !interviewCount
                            ? 'cursor-not-allowed'
                            : '')
                        }
                        style={
                          attributedToMM === null || !appliedCount || !emailedCount || !interviewCount
                            ? { backgroundColor: COLORS.bgMuted, color: COLORS.textMuted }
                            : { backgroundColor: hoverJobContinue ? COLORS.brandStrong : COLORS.brand, color: COLORS.textOnBrand }
                        }
                        onMouseEnter={() => { if (!(attributedToMM === null || !appliedCount || !emailedCount || !interviewCount)) setHoverJobContinue(true); }}
                        onMouseLeave={() => { if (!(attributedToMM === null || !appliedCount || !emailedCount || !interviewCount)) setHoverJobContinue(false); }}
                      >
                        Continue
                      </button>
                    </div>
                  </div>
                </>
              )}

              {currentStep === 'downsell' && (
                <>
                  {/* Headline exactly as Figma */}
                  <h3
                    className="font-sans text-[28px] leading-[1.06] md:text-[36px] md:leading-[1.08] font-normal tracking-tight mb-3"
                    style={{ color: COLORS.textPrimary }}
                  >
                    We built this to help you land the job, this makes it a little easier.
                  </h3>

                  {/* Sub-head copy */}
                  <p
                    className="font-sans text-[16px] md:text-[18px] font-normal mb-4"
                    style={{ color: COLORS.textSecondary }}
                  >
                    We’ve been there and we’re here to help you.
                  </p>

                  {/* Lavender offer card */}
                  <div
                    className="rounded-[18px] border-2 px-4 py-2 md:px-6 md:py-3 mb-3 shadow-sm text-center"
                    style={{ borderColor: COLORS.accent, background: COLORS.cardBg }}
                  >
                    <p
                      className="font-sans text-[20px] md:text-[22px] font-medium leading-[1.1] mb-1.5"
                      style={{ color: COLORS.textPrimary }}
                    >
                      Here’s <span className="underline">$10 off</span> until you find a job.
                    </p>

                    {/* Price row as in Figma ($10 off variant) */}
                    <div className="flex items-baseline justify-center gap-2 md:gap-3 mb-2 leading-none">
                      <span
                        className="font-sans text-[26px] md:text-[16px] font-bold"
                        style={{ color: COLORS.accent }}
                      >${formatMoney(DISCOUNTED_PRICE_DOLLARS)}/month</span>
                      <span
                        className="font-sans text-[18px] md:text-[16px] font-normal line-through ml-1"
                        style={{ color: COLORS.textMuted }}
                      >${formatMoney(BASE_PRICE_DOLLARS)}/month</span>
                    </div>

                    {/* Primary CTA */}
                    <button
                      onClick={async () => {
                        if (!cancellationId) return;
                        try {
                          await acceptDownsell(cancellationId);
                          setAcceptedDownsell(true);
                          setCurrentStep('downsell-accepted');
                        } catch (e) {
                          console.error('Failed to accept downsell', e);
                        }
                      }}
                    className="w-full rounded-xl text-white text-[16px] font-sans font-semibold py-2.5 md:py-3 transition"
                    style={{ backgroundColor: hoverDownsellCTA ? COLORS.successStrong : COLORS.success }}
                    onMouseEnter={() => setHoverDownsellCTA(true)}
                    onMouseLeave={() => setHoverDownsellCTA(false)}
                  >
                    Get $10 off
                  </button>

                    {/* Footnote */}
                    <p
                      className="mt-2 text-center text-[12px] md:text-[13px] font-sans font-normal italic leading-tight"
                      style={{ color: COLORS.textMuted }}
                    >
                      You won't be charged until your next billing date.
                    </p>
                  </div>

                  {/* Divider to match Figma spacing */}
                  <hr
                    className="my-4 border-t"
                    style={{ borderColor: COLORS.borderLight, borderTopWidth: 1, borderStyle: 'solid' }}
                  />

                  {/* Secondary action */}
                  <button
                    onClick={() => setCurrentStep('using')}
                    className="w-full select-none touch-manipulation rounded-2xl border-2 px-4 py-3 text-[16px] font-semibold shadow-sm transition-colors focus-visible:outline-none"
                    style={
                      hoverNoThanks
                        ? { backgroundColor: COLORS.brand, borderColor: COLORS.brand, color: COLORS.textOnBrand }
                        : { backgroundColor: COLORS.bgWhite, borderColor: COLORS.border, color: COLORS.textSecondary }
                    }
                    onMouseEnter={() => setHoverNoThanks(true)}
                    onMouseLeave={() => setHoverNoThanks(false)}
                  >
                    No thanks
                  </button>
                </>
              )}

              {/* New 'using' step for still-looking path */}
              {currentStep === 'using' && (
                <>
                  <h3
                    className="text-[26px] md:text-[30px] font-extrabold mb-3"
                    style={{ color: COLORS.textPrimary }}
                  >
                    Help us understand how you were using Migrate Mate.
                  </h3>
                  <div className="space-y-5">
                    <div>
                      <p
                        className="text-sm font-medium mb-2"
                        style={{ color: COLORS.textSecondary }}
                      >
                        How many roles did you apply for through Migrate Mate?*
                      </p>
                      <Segments options={['0','1-5','6-20','20+']} value={appliedCount} onChange={(v)=>setAppliedCount(v as typeof appliedCount)} />
                    </div>
                    <div>
                      <p
                        className="text-sm font-medium mb-2"
                        style={{ color: COLORS.textSecondary }}
                      >
                        How many companies did you email directly?*
                      </p>
                      <Segments options={['0','1-5','6-20','20+']} value={emailedCount} onChange={(v)=>setEmailedCount(v as typeof emailedCount)} />
                    </div>
                    <div>
                      <p
                        className="text-sm font-medium mb-2"
                        style={{ color: COLORS.textSecondary }}
                      >
                        How many different companies did you interview with?*
                      </p>
                      <Segments options={['0','1-2','3-5','5+']} value={interviewCount} onChange={(v)=>setInterviewCount(v as typeof interviewCount)} />
                    </div>
                    {/* Green CTA for B variant & not accepted */}
                    {downsellVariant === 'B' && !acceptedDownsell && (
                      <div>
                        <button
                          className="w-full rounded-xl text-white text-[16px] font-sans font-semibold py-2.5 md:py-3 transition"
                          style={{ backgroundColor: hoverDownsellCTA ? COLORS.successStrong : COLORS.success }}
                          onMouseEnter={() => setHoverDownsellCTA(true)}
                          onMouseLeave={() => setHoverDownsellCTA(false)}
                        onClick={async () => {
                          if (!cancellationId) return;
                          try {
                            await acceptDownsell(cancellationId);
                            setAcceptedDownsell(true);
                            setCurrentStep('downsell-accepted');
                          } catch (e) {
                            console.error('Failed to accept downsell', e);
                          }
                        }}
                        >
                          Get $10 off
                        </button>
                      </div>
                    )}
                    <div className="pt-2 text-center">
                      <button
                        disabled={!appliedCount || !emailedCount || !interviewCount}
                        className={
                          'w-full rounded-2xl px-4 py-3 text-[15px] font-semibold text-white ' +
                          (!appliedCount || !emailedCount || !interviewCount ? 'cursor-not-allowed' : '')
                        }
                        style={
                          !appliedCount || !emailedCount || !interviewCount
                            ? { backgroundColor: COLORS.bgMuted, color: COLORS.textMuted }
                            : { backgroundColor: hoverUsingContinue ? COLORS.dangerStrong : COLORS.danger, color: COLORS.textOnBrand }
                        }
                        onMouseEnter={() => { if (appliedCount && emailedCount && interviewCount) setHoverUsingContinue(true); }}
                        onMouseLeave={() => { if (appliedCount && emailedCount && interviewCount) setHoverUsingContinue(false); }}
                        onClick={async () => {
                          if (!(appliedCount && emailedCount && interviewCount)) return;
                          // Explicit save using the shared payload builder before advancing
                          if (cancellationId) {
                            const payload = buildDraftPayload();
                            if (Object.keys(payload).length) {
                              try { await saveFoundJobAnswersRpc(cancellationId, payload); } catch (e) { /* optional debug */ }
                            }
                          }
                          setCurrentStep('reasons');
                        }}
                      >
                        Continue
                      </button>
                    </div>
                  </div>
                </>
              )}

              {currentStep === 'reasons' && (
                <>
                  <h3
                    className="text-[26px] md:text-[28px] font-extrabold mb-2"
                    style={{ color: COLORS.textPrimary }}
                  >
                    What’s the main reason for cancelling?
                  </h3>
                  <p
                    className="text-[14px] md:text-[15px] mb-4"
                    style={{ color: COLORS.textMuted }}
                  >
                    Please take a minute to let us know why.
                  </p>

                  {/* Radio list */}
                  <div className="space-y-3 mb-4">
                    {[
                      { key: 'too_expensive', label: 'Too expensive' },
                      { key: 'not_helpful', label: 'Platform not helpful' },
                      { key: 'not_enough_jobs', label: 'Not enough relevant jobs' },
                      { key: 'decided_not_to_move', label: 'Decided not to move' },
                      { key: 'other', label: 'Other' },
                    ].map((r) => (
                      <label key={r.key} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="reason"
                          className="h-4 w-4"
                          style={{ accentColor: COLORS.brand }}
                          checked={reasonChoice === (r.key as any)}
                          onChange={() => { setReasonChoice(r.key as any); setReasonTouched(true); }}
                        />
                        <span
                          className="text-sm"
                          style={{ color: COLORS.textSecondary }}
                        >
                          {r.label}
                        </span>
                      </label>
                    ))}
                  </div>

                  {/* Conditional inputs */}
                  {reasonChoice === 'too_expensive' ? (
                    <div className="mb-4">
                      <label
                        className="block text-sm font-medium mb-1"
                        style={{ color: COLORS.textSecondary }}
                      >
                        What would be the maximum you’d be willing to pay?
                      </label>
                      <div className="relative">
                        <span
                          className="absolute left-3 top-1/2 -translate-y-1/2"
                          style={{ color: COLORS.textMuted }}
                        >
                          $
                        </span>
                        <input
                          type="text"
                          value={maxPrice}
                          onChange={(e) => setMaxPrice(e.target.value)}
                          className="w-full rounded-lg border px-7 py-2 focus:outline-none focus:ring-2"
                          style={{
                            borderColor: COLORS.border,
                            backgroundColor: COLORS.bgWhite,
                            color: COLORS.textPrimary
                          }}
                        />
                      </div>
                    </div>
                  ) : reasonChoice ? (
                    <div className="mb-4">
                      <label
                        className="block text-sm font-medium mb-1"
                        style={{ color: COLORS.textSecondary }}
                      >
                        {reasonChoice === 'not_helpful' && 'What can we change to make the platform more helpful?*'}
                        {reasonChoice === 'not_enough_jobs' && 'In which way can we make the jobs more relevant?*'}
                        {reasonChoice === 'decided_not_to_move' && 'What changed for you to decide to not move?*'}
                        {reasonChoice === 'other' && 'What would have helped you the most?*'}
                      </label>
                      <div className="relative">
                        <textarea
                          value={reasonText}
                          onChange={(e) => setReasonText(e.target.value)}
                          onBlur={() => setReasonTouched(true)}
                          rows={5}
                          className={`w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 resize-none`}
                          style={{
                            borderColor: reasonTouched && sanitizeText(reasonText).length < 25 ? COLORS.error : COLORS.border,
                            backgroundColor: COLORS.bgWhite,
                            color: COLORS.textPrimary
                          }}
                        />
                        <div
                          className="pointer-events-none absolute bottom-2 right-3 text-xs"
                          style={{ color: COLORS.textMuted }}
                        >
                          Min 25 characters ({Math.min(sanitizeText(reasonText).length, 25)}/25)
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {/* Actions */}
                  {downsellVariant === 'B' && !acceptedDownsell && (
                    <button
                      className="w-full rounded-xl text-white text-[16px] font-sans font-semibold py-2.5 md:py-3 transition mb-3"
                      style={{ backgroundColor: hoverDownsellCTA ? COLORS.successStrong : COLORS.success }}
                      onMouseEnter={() => setHoverDownsellCTA(true)}
                      onMouseLeave={() => setHoverDownsellCTA(false)}
                      onClick={async () => {
                        if (!cancellationId) return;
                        try {
                          await acceptDownsell(cancellationId);
                          setAcceptedDownsell(true);
                          setCurrentStep('downsell-accepted');
                        } catch (e) {
                          console.error('Failed to accept downsell', e);
                        }
                      }}
                    >
                      Get $10 off
                    </button>
                  )}

                  <button
                    disabled={!reasonChoice || (reasonChoice !== 'too_expensive' && sanitizeText(reasonText).length < 25)}
                    className={`w-full rounded-2xl px-4 py-3 text-[15px] font-semibold transition-colors ${!reasonChoice || (reasonChoice !== 'too_expensive' && reasonText.trim().length < 25) ? 'cursor-not-allowed' : ''}`}
                    style={
                      !reasonChoice || (reasonChoice !== 'too_expensive' && reasonText.trim().length < 25)
                        ? { backgroundColor: COLORS.bgMuted, color: COLORS.textMuted }
                        : { backgroundColor: hoverCompleteCancel ? COLORS.dangerStrong : COLORS.danger, color: COLORS.textOnBrand }
                    }
                    onMouseEnter={() => { if (reasonChoice && (reasonChoice === 'too_expensive' || sanitizeText(reasonText).length >= 25)) setHoverCompleteCancel(true); }}
                    onMouseLeave={() => { if (reasonChoice && (reasonChoice === 'too_expensive' || sanitizeText(reasonText).length)) setHoverCompleteCancel(false); }}
                    onClick={async () => {
                      if (cancellationId) {
                        const raw = reasonChoice === 'too_expensive'
                                      ? (maxPrice ? `Too expensive; willing to pay $${maxPrice}` : 'Too expensive')
                                      : reasonText;
                        const text = sanitizeText(raw);
                        try { await finalizeStillLooking(cancellationId, text ?? ''); } catch (e) { console.error('Failed to finalize cancellation', e); return; }
                      }
                      setVisaHasLawyer(false);
                      setCurrentStep('completed');
                    }}
                  >
                    Complete cancellation
                  </button>
                </>
              )}

              {currentStep === 'downsell-accepted' && (
                <>
                  <div>
                    <h3
                      className="text-[26px] md:text-[28px] font-semibold mb-2"
                      style={{ color: COLORS.textPrimary }}
                    >
                      Great choice, mate!
                    </h3>
                    <p
                      className="text-[16px] md:text-[18px] mb-4 leading-snug"
                      style={{ color: COLORS.textSecondary }}
                    >
                      You’re still on the path to your dream role.{' '}
                      <span className="font-semibold" style={{ color: COLORS.brand }}>Let’s make it happen together!</span>
                    </p>
                    <div className="space-y-1.5 text-[13px] md:text-[14px]" style={{ color: COLORS.textSecondary }}>
                      <p>You’ve got XX days left on your current plan.</p>
                      <p>Starting from XX date, your monthly payment will be <span className="font-medium">${formatMoney(DISCOUNTED_PRICE_DOLLARS)}</span>.</p>
                      <p className="italic" style={{ color: COLORS.textMuted }}>You can cancel anytime before then.</p>
                    </div>
                  </div>
                  <div className="pt-4">
                    <hr
                      className="mb-4 border-t"
                      style={{ borderColor: COLORS.borderLight, borderTopWidth: 1, borderStyle: 'solid' }}
                    />
                    <button
                      onClick={handleClose}
                      className="w-full rounded-2xl text-white px-4 py-3 text-[15px] font-semibold transition"
                      style={{ backgroundColor: hoverDownsellAcceptedCTA ? COLORS.brandStrong : COLORS.brand }}
                      onMouseEnter={() => setHoverDownsellAcceptedCTA(true)}
                      onMouseLeave={() => setHoverDownsellAcceptedCTA(false)}
                    >
                      Land your dream role
                    </button>
                  </div>
                </>
              )}

              {currentStep === 'feedback' && selectedOption === 'found-job' && (
                <>
                  <h3
                    className="text-[28px] md:text-[30px] font-extrabold mb-3"
                    style={{ color: COLORS.textPrimary }}
                  >
                    What’s one thing you wish we could’ve helped you with?
                  </h3>

                  <p
                    className="text-[14px] md:text-[15px] mb-4"
                    style={{ color: COLORS.textMuted }}
                  >
                    We’re always looking to improve, your thoughts can help us make Migrate Mate more useful for others.
                  </p>

                  <div>
                    <div className="relative">
                      <textarea
                        value={feedback}
                        onChange={(e) => { setFeedback(e.target.value); if (!feedbackTouched) setFeedbackTouched(true); }}
                        onBlur={() => setFeedbackTouched(true)}
                        placeholder="Share your thoughts with us..."
                        className={
                          `w-full px-4 py-3 border rounded-lg focus:ring-2 focus:border-transparent resize-none bg-white text-gray-900 placeholder-gray-400 ` +
                          (feedbackTouched && feedback.trim().length < MIN_FEEDBACK
                            ? 'border-red-400 focus:ring-red-300'
                            : 'border-gray-300')
                        }
                        rows={5}
                      />
                      <div
                        className="pointer-events-none absolute bottom-2 right-3 text-xs"
                        style={{ color: COLORS.textMuted }}
                      >
                        Min {MIN_FEEDBACK} characters ({Math.min(sanitizeText(feedback).length, MIN_FEEDBACK)}/{MIN_FEEDBACK})
                      </div>
                    </div>

                    {/* Optional green CTA for still-looking + B variant + not accepted */}

                    <div className="mt-4 flex items-center gap-3">
                      <button
                        onClick={handleFeedbackSubmit}
                        disabled={feedback.trim().length < MIN_FEEDBACK}
                        className={
                          'flex-1 px-6 py-3 rounded-lg font-semibold transition-colors ' +
                          (feedback.trim().length < MIN_FEEDBACK
                            ? 'cursor-not-allowed'
                            : '')
                        }
                        style={
                          feedback.trim().length < MIN_FEEDBACK
                            ? { backgroundColor: COLORS.bgMuted, color: COLORS.textMuted }
                            : { backgroundColor: hoverFeedbackContinue ? COLORS.brandStrong : COLORS.brand, color: COLORS.textOnBrand }
                        }
                        onMouseEnter={() => { if (feedback.trim().length >= MIN_FEEDBACK) setHoverFeedbackContinue(true); }}
                        onMouseLeave={() => { if (feedback.trim().length >= MIN_FEEDBACK) setHoverFeedbackContinue(false); }}
                      >
                        Continue
                      </button>
                    </div>
                  </div>
                </>
              )}

              {currentStep === 'confirmation' && (
                <>
                  {/* Step 3: Visa helper question */}
                  <h3
                    className="text-[26px] md:text-[28px] font-extrabold leading-tight mb-2"
                    style={{ color: COLORS.textPrimary }}
                  >
                    {attributedToMM
                      ? "We helped you land the job, now let’s help you secure your visa."
                      : "You landed the job! That's what we live for."}
                  </h3>

                  {!attributedToMM && (
                    <p
                      className="text-[15px] mb-6"
                      style={{ color: COLORS.textSecondary }}
                    >
                      Even if it wasn’t through Migrate Mate, let us help get your visa sorted.
                    </p>
                  )}

                  <div className="space-y-5">
                    <p
                      className="text-sm font-medium"
                      style={{ color: COLORS.textSecondary }}
                    >
                      Is your company providing an immigration lawyer to help with your visa?*
                    </p>

                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setVisaHasLawyer(true)}
                        className="rounded-lg border px-4 py-2 text-sm font-medium transition"
                        style={
                          visaHasLawyer === true
                            ? { borderColor: COLORS.brand, backgroundColor: COLORS.brand, color: '#fff' }
                            : { borderColor: '#D1D5DB', backgroundColor: '#fff', color: '#374151' }
                        }
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisaHasLawyer(false)}
                        className="rounded-lg border px-4 py-2 text-sm font-medium transition"
                        style={
                          visaHasLawyer === false
                            ? { borderColor: COLORS.brand, backgroundColor: COLORS.brand, color: '#fff' }
                            : { borderColor: '#D1D5DB', backgroundColor: '#fff', color: '#374151' }
                        }
                      >
                        No
                      </button>
                    </div>

                    {/* Follow-up content based on Yes/No */}
                    {visaHasLawyer !== null && (
                      <div className="space-y-3">
                        {visaHasLawyer ? (
                          // YES: they have a lawyer
                          <>
                            <label
                              className="block text-sm font-medium"
                              style={{ color: COLORS.textSecondary }}
                            >
                              What visa will you be applying for?*
                            </label>
                            <input
                              type="text"
                              value={visaType}
                              onChange={(e) => setVisaType(e.target.value)}
                              placeholder="e.g., H‑1B, O‑1, E‑3, TN…"
                              className="w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2"
                              style={{
                                borderColor: COLORS.border,
                                backgroundColor: COLORS.bgWhite,
                                color: COLORS.textPrimary
                              }}
                            />
                          </>
                        ) : (
                          // NO: connect with trusted partners
                          <>
                            <p
                              className="text-sm"
                              style={{ color: COLORS.textSecondary }}
                            >
                              We can connect you with one of our trusted partners.
                            </p>
                            <label
                              className="block text-sm font-medium"
                              style={{ color: COLORS.textSecondary }}
                            >
                              Which visa would you like to apply for?*
                            </label>
                            <input
                              type="text"
                              value={visaType}
                              onChange={(e) => setVisaType(e.target.value)}
                              placeholder="e.g., H‑1B, O‑1, E‑3, TN…"
                              className="w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2"
                              style={{
                                borderColor: COLORS.border,
                                backgroundColor: COLORS.bgWhite,
                                color: COLORS.textPrimary
                              }}
                            />
                          </>
                        )}
                      </div>
                    )}

                    <div className="pt-2">
                      <button
                        onClick={async () => {
                          if (cancellationId) {
                            try {
                              await finalizeFoundJob(cancellationId, !!visaHasLawyer, sanitizeText(visaType));
                            } catch (e) { console.error('Failed to finalize cancellation', e); return; }
                          }
                          setCurrentStep('completed');
                        }}
                        disabled={visaHasLawyer === null || sanitizeText(visaType) === ''}
                        className={
                          'w-full rounded-2xl px-4 py-3 text-[15px] font-semibold transition-colors ' +
                          (visaHasLawyer === null || sanitizeText(visaType) === ''
                            ? 'cursor-not-allowed'
                            : '')
                        }
                        style={
                          visaHasLawyer === null || sanitizeText(visaType) === ''
                            ? { backgroundColor: COLORS.bgMuted, color: COLORS.textMuted }
                            : { backgroundColor: hoverCompleteCancel ? COLORS.dangerStrong : COLORS.danger, color: COLORS.textOnBrand }
                        }
                        onMouseEnter={() => { if (!(visaHasLawyer === null || sanitizeText(visaType) === '')) setHoverCompleteCancel(true); }}
                        onMouseLeave={() => { if (!(visaHasLawyer === null || sanitizeText(visaType) === '')) setHoverCompleteCancel(false); }}
                      >
                        Complete cancellation
                      </button>
                    </div>
                  </div>
                </>
              )}

              {currentStep === 'completed' && (
                <div className="space-y-4">
                  {selectedOption === 'still-looking' || selectedOption === null ? (
                    <>
                      <h3
                        className="text-[24px] md:text-[26px] font-extrabold leading-tight"
                        style={{ color: COLORS.textPrimary }}
                      >
                        Sorry to see you go, mate.
                      </h3>
                      <div className="space-y-2" style={{ color: COLORS.textSecondary }}>
                        <p className="text-[16px] md:text-[18px] font-semibold">Thanks for being with us, and you’re always welcome back.</p>
                        <div className="text-sm">
                          <p>Your subscription is set to end on XX date.</p>
                          <p>You’ll still have full access until then. No further charges after that.</p>
                        </div>
                        <p className="text-xs md:text-sm" style={{ color: COLORS.textMuted }}>Changed your mind? You can reactivate anytime before your end date.</p>
                      </div>
                      <div className="pt-2">
                        <button
                          onClick={handleClose}
                          className="w-full rounded-2xl px-4 py-3 text-[15px] font-semibold transition-colors"
                          style={{ backgroundColor: hoverFinish1 ? COLORS.brandStrong : COLORS.brand, color: COLORS.textOnBrand }}
                          onMouseEnter={() => setHoverFinish1(true)}
                          onMouseLeave={() => setHoverFinish1(false)}
                        >
                          Back to Jobs
                        </button>
                      </div>
                    </>
                  ) : visaHasLawyer === true ? (
                    <>
                      <h3
                        className="text-[22px] md:text-[24px] font-extrabold leading-tight"
                        style={{ color: COLORS.textPrimary }}
                      >
                        All done, your cancellation’s been processed.
                      </h3>
                      <p
                        className="text-sm md:text-[15px]"
                        style={{ color: COLORS.textSecondary }}
                      >
                        We’re stoked to hear you’ve landed a job and sorted your visa. Big congrats from the team. 🙌
                      </p>
                      <div className="pt-2">
                        <button
                          onClick={handleClose}
                          className="w-full rounded-2xl px-4 py-3 text-[15px] font-semibold transition-colors"
                          style={{ backgroundColor: hoverFinish1 ? COLORS.brandStrong : COLORS.brand, color: COLORS.textOnBrand }}
                          onMouseEnter={() => setHoverFinish1(true)}
                          onMouseLeave={() => setHoverFinish1(false)}
                        >
                          Finish
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3
                        className="text-[22px] md:text-[24px] font-extrabold leading-tight"
                        style={{ color: COLORS.textPrimary }}
                      >
                        Your cancellation’s all sorted, mate, no more charges.
                      </h3>
                      <div
                        className="rounded-xl border p-3 sm:p-4"
                        style={{ borderColor: COLORS.borderLight, backgroundColor: COLORS.bgMuted }}
                      >
                        <div className="flex items-center gap-3">
                          <img
                            src="/mihailo-profile.jpeg"
                            alt="Mihailo Bozic"
                            className="h-10 w-10 rounded-full object-cover"
                            style={{ backgroundColor: COLORS.border }}
                            onError={(e) => {
                              // graceful fallback if the image isn't available
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                          <div className="leading-tight">
                            <p className="text-sm font-semibold" style={{ color: COLORS.textSecondary }}>Mihailo Bozic</p>
                            <p className="text-xs" style={{ color: COLORS.textMuted }}>
                              <a href="mailto:mihailo@migratemate.co" className="hover:underline">mihailo@migratemate.co</a>
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 text-sm" style={{ color: COLORS.textSecondary }}>
                          <p className="font-semibold">I’ll be reaching out soon to help with the visa side of things.</p>
                          <p className="mt-2">We’ve got your back, whether it’s questions, paperwork, or just figuring out your options.</p>
                          <p className="mt-2" style={{ color: COLORS.textMuted }}>Keep an eye on your inbox, I’ll be in touch <span className="underline">shortly</span>.</p>
                        </div>
                      </div>
                      <div className="pt-2">
                        <button
                          onClick={handleClose}
                          className="w-full rounded-2xl px-4 py-3 text-[15px] font-semibold transition-colors"
                          style={{ backgroundColor: hoverFinish2 ? COLORS.brandStrong : COLORS.brand, color: COLORS.textOnBrand }}
                          onMouseEnter={() => setHoverFinish2(true)}
                          onMouseLeave={() => setHoverFinish2(false)}
                        >
                          Finish
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right Panel - Image (thumbnail card to match Figma) */}
          <div className={`order-1 md:order-2 items-center ${currentStep==='downsell-accepted' ? 'p-4 md:p-6' : 'p-5 md:p-4'} flex`}>
            <div
              className={`relative w-full ${currentStep==='downsell-accepted' ? 'h-52 sm:h-60 md:h-[400px]' : 'h-48 sm:h-56 md:h-[380px]'} overflow-hidden rounded-2xl shadow-sm`}
              style={{ boxShadow: '0 0 0 1px rgba(0,0,0,0.10)' }}
            >
              <img
                src="/empire-state-compressed.jpg"
                alt="New York City Skyline with Empire State Building"
                className={`absolute inset-0 h-full w-full object-cover ${currentStep==='downsell-accepted' ? 'object-center md:scale-[1.08]' : 'object-center'}`}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}