'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase, ensureCancellation, saveFoundJobAnswers } from '@/lib/supabase';

const COLORS = {
  brand: '#8952fc',
  brandStrong: '#7b40fc',
  accent: '#6b4eff',
  cardBg: '#efe7ff',
  success: '#35b34a',
  successStrong: '#2ea743',
};


type CancellationStep = 'initial' | 'job-status' | 'downsell' | 'downsell-accepted' | 'using' | 'reasons' | 'feedback' | 'confirmation' | 'completed';

interface CancellationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CancellationModal({ isOpen, onClose }: CancellationModalProps) {
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

  // TODO: replace with real authenticated user id when wiring auth.
  const getMockUserId = () => '00000000-0000-0000-0000-000000000001';

  async function getOrAssignDownsellVariant(): Promise<{ variant: 'A' | 'B'; id: string | null; source: 'db' | 'local' }> {
    // Secure RNG
    const buf = new Uint32Array(1);
    try { window.crypto.getRandomValues(buf); } catch {}
    const pick: 'A' | 'B' = (buf[0] || Math.floor(Math.random() * 2)) % 2 === 0 ? 'A' : 'B';

    try {
      const userId = getMockUserId();
      // Reuse existing variant if present
      const { data: existing, error: selErr } = await supabase
        .from('cancellations')
        .select('id, downsell_variant')
        .eq('user_id', userId)
        .not('downsell_variant', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);
      if (selErr) throw selErr;
      if (existing && existing.length && (existing[0].downsell_variant === 'A' || existing[0].downsell_variant === 'B')) {
        return { variant: existing[0].downsell_variant as 'A' | 'B', id: existing[0].id, source: 'db' };
      }
      // Create a fresh cancellation row with variant
      const { data: inserted, error: insErr } = await supabase
        .from('cancellations')
        .insert({ user_id: userId, downsell_variant: pick })
        .select('id, downsell_variant')
        .single();
      if (insErr) throw insErr;
      return { variant: inserted!.downsell_variant as 'A' | 'B', id: inserted!.id, source: 'db' };
    } catch (e) {
      // Fallback to localStorage for determinism on this device
      try {
        const KEY = 'mm_downsell_variant';
        const cached = typeof window !== 'undefined' ? window.localStorage.getItem(KEY) : null;
        if (cached === 'A' || cached === 'B') return { variant: cached, id: null, source: 'local' };
        if (typeof window !== 'undefined') window.localStorage.setItem(KEY, pick);
        return { variant: pick, id: null, source: 'local' };
      } catch {
        return { variant: pick, id: null, source: 'local' };
      }
    }
  }
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

  const handleOptionSelect = async (option: 'found-job' | 'still-looking') => {
    setSelectedOption(option);
    if (option === 'found-job') {
      // Ensure a cancellation row exists for this user and keep its id
      try {
        const userId = getMockUserId();
        const row = await ensureCancellation(userId, null);
        setCancellationId(row.id);
      } catch (e) {
        console.error('Failed to ensure cancellation row', e);
      }
      setCurrentStep('job-status');
      return;
    }
    try {
      setAbLoading(true);
      const res = await getOrAssignDownsellVariant();
      setDownsellVariant(res.variant);
      setCancellationId(res.id);
      if (res.variant === 'B') setCurrentStep('downsell');
      else setCurrentStep('using');
    } finally {
      setAbLoading(false);
    }
  };

  const handleFeedbackSubmit = async () => {
    try {
      // Persist step 1+2 answers only for found-job branch
      if (selectedOption === 'found-job' && cancellationId) {
        await saveFoundJobAnswers(cancellationId, {
          attributed_to_mm: attributedToMM ?? undefined,
          applied_count: (appliedCount || undefined) as any,
          emailed_count: (emailedCount || undefined) as any,
          interview_count: (interviewCount || undefined) as any,
        });
        // Save feedback text as reason if provided
        const trimmed = feedback.trim();
        if (trimmed.length > 0) {
          await supabase.from('cancellations').update({ reason: trimmed }).eq('id', cancellationId);
        }
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

  const handleClose = () => {
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

  const Segments = ({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void; }) => (
    <div className="grid grid-cols-4 gap-3">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={
            'rounded-lg border px-3 py-2 text-sm font-medium transition ' +
            (value === opt
              ? 'border-indigo-600 bg-indigo-600 text-white'
              : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400')
          }
        >
          {opt}
        </button>
      ))}
    </div>
  );

  if (!isOpen) return null;

  // Show back button on all steps except initial, completed, downsell-accepted
  const showBack = !['initial','completed','downsell-accepted'].includes(currentStep);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
            {/* Back (left) */}
            {showBack ? (
              <button
                onClick={handleBack}
                aria-label="Back"
                className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-gray-700 hover:bg-gray-100 hover:text-gray-900"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/></svg>
                <span className="text-sm font-medium">Back</span>
              </button>
            ) : (
              <span className="h-5 w-5"/>
            )}

            {/* Title + progress (center) */}
            <div className="flex flex-col md:flex-row items-center justify-center gap-1 md:gap-3">
              <p className="text-[16px] md:text-[17px] font-medium text-gray-900">
                {currentStep === 'completed'
                  ? 'Subscription Cancelled'
                  : currentStep === 'downsell-accepted'
                    ? 'Subscription'
                    : 'Subscription Cancellation'}
              </p>
              {(currentStep === 'job-status' || currentStep === 'downsell' || currentStep === 'using' || currentStep === 'feedback' || currentStep === 'confirmation' || currentStep === 'completed') && (
                <div className="mt-1 md:mt-0 flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    {[1,2,3].map((n) => {
                      const step = getStepNumber();
                      const color = currentStep === 'completed' ? 'bg-green-500' : (step > n ? 'bg-green-500' : step === n ? 'bg-gray-400' : 'bg-gray-200');
                      return (
                        <span key={n} className={`h-1.5 w-4 md:h-2 md:w-5 rounded-full ${color}`} />
                      );
                    })}
                  </div>
                  <span className="text-[11px] md:text-xs text-gray-500">{currentStep === 'completed' ? 'Completed' : `Step ${getStepNumber()} of ${totalSteps}`}</span>
                </div>
              )}
            </div>

            {/* Close (right) */}
            <button
              onClick={handleClose}
              className="justify-self-end rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
              aria-label="Close modal"
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
          <div className={`order-2 md:order-1 px-5 md:px-6 ${currentStep==='downsell-accepted' ? 'py-4 md:py-6' : 'py-5'} flex flex-col ${currentStep==='downsell-accepted' ? 'justify-between' : 'justify-center'}`}>
            <div>
              {currentStep === 'initial' && (
                <>
                  <h3 className="text-[26px] md:text-[32px] font-extrabold leading-tight tracking-[-0.01em] text-gray-900 mb-2">
                    Hey mate,<br/>Quick one before you go.
                  </h3>
                  
                  <h4 className="text-[22px] md:text-[26px] italic font-semibold text-gray-900 mb-4">
                    Have you found a job yet?
                  </h4>
                  
                  <p className="text-[15px] md:text-[16px] text-gray-600 leading-relaxed mb-4">
                    Whatever your answer, we just want to help you take the next step.
                    With visa support, or by hearing how we can do better.
                  </p>
                  <hr className="my-5 border-t border-gray-200" />
                  <div className="space-y-4">
                    <button
                      onClick={() => handleOptionSelect('found-job')}
                      disabled={abLoading}
                      className={
                        "w-full select-none touch-manipulation rounded-2xl border px-4 py-3 text-[15px] font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 border-gray-300 bg-white " +
                        (hoverInitYes ? "text-white" : "text-gray-800") +
                        (abLoading ? ' opacity-60 cursor-wait' : '')
                      }
                      style={hoverInitYes ? { backgroundColor: COLORS.brand, borderColor: COLORS.brand, /* @ts-ignore */ ['--tw-ring-color' as string]: COLORS.brand } : { /* @ts-ignore */ ['--tw-ring-color' as string]: COLORS.brand }}
                      onMouseEnter={() => setHoverInitYes(true)}
                      onMouseLeave={() => setHoverInitYes(false)}
                    >
                      Yes, I’ve found a job
                    </button>

                    <button
                      onClick={() => handleOptionSelect('still-looking')}
                      disabled={abLoading}
                      className={
                        "w-full select-none touch-manipulation rounded-2xl border px-4 py-3 text-[15px] font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 border-gray-300 bg-white " +
                        (hoverInitNo ? "text-white" : "text-gray-800") +
                        (abLoading ? ' opacity-60 cursor-wait' : '')
                      }
                      style={hoverInitNo ? { backgroundColor: COLORS.brand, borderColor: COLORS.brand, /* @ts-ignore */ ['--tw-ring-color' as string]: COLORS.brand } : { /* @ts-ignore */ ['--tw-ring-color' as string]: COLORS.brand }}
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
                  <h3 className="text-xl md:text-2xl font-bold text-gray-900 mb-2">Congrats on the new role! 🎉</h3>

                  <div className="space-y-5">
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">Did you find this job with Migrate Mate?*</p>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setAttributedToMM(true)}
                          className={
                            'rounded-lg border px-4 py-2 text-sm font-medium transition ' +
                            (attributedToMM === true
                              ? 'border-indigo-600 bg-indigo-600 text-white'
                              : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400')
                          }
                        >
                          Yes
                        </button>
                        <button
                          type="button"
                          onClick={() => setAttributedToMM(false)}
                          className={
                            'rounded-lg border px-4 py-2 text-sm font-medium transition ' +
                            (attributedToMM === false
                              ? 'border-indigo-600 bg-indigo-600 text-white'
                              : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400')
                          }
                        >
                          No
                        </button>
                      </div>
                    </div>

                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">How many roles did you apply for through Migrate Mate?*</p>
                      <Segments options={['0','1-5','6-20','20+']} value={appliedCount} onChange={(v)=>setAppliedCount(v as any)} />
                    </div>

                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">How many companies did you email directly?*</p>
                      <Segments options={['0','1-5','6-20','20+']} value={emailedCount} onChange={(v)=>setEmailedCount(v as any)} />
                    </div>

                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">How many different companies did you interview with?*</p>
                      <Segments options={['0','1-2','3-5','5+']} value={interviewCount} onChange={(v)=>setInterviewCount(v as any)} />
                    </div>

                    <div className="pt-2">
                      <button
                        onClick={() => setCurrentStep('feedback')}
                        disabled={
                          attributedToMM === null || !appliedCount || !emailedCount || !interviewCount
                        }
                        className={
                          'w-full rounded-2xl px-4 py-3 text-[15px] font-semibold transition-colors ' +
                          (attributedToMM === null || !appliedCount || !emailedCount || !interviewCount
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'text-white')
                        }
                        style={
                          attributedToMM === null || !appliedCount || !emailedCount || !interviewCount
                            ? undefined
                            : { backgroundColor: hoverJobContinue ? COLORS.brandStrong : COLORS.brand }
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
                  <h3 className="font-sans text-[28px] leading-[1.06] md:text-[36px] md:leading-[1.08] font-normal tracking-tight text-gray-900 mb-3">
                    We built this to help you land the job, this makes it a little easier.
                  </h3>

                  {/* Sub-head copy */}
                  <p className="font-sans text-[16px] md:text-[18px] text-gray-700 font-normal mb-4">
                    We’ve been there and we’re here to help you.
                  </p>

                  {/* Lavender offer card */}
                  <div
                    className="rounded-[18px] border-2 px-4 py-2 md:px-6 md:py-3 mb-3 shadow-sm text-center"
                    style={{ borderColor: COLORS.accent, background: COLORS.cardBg }}
                  >
                    <p className="font-sans text-[20px] md:text-[22px] font-medium text-gray-900 leading-[1.1] mb-1.5">
                      Here’s <span className="underline">50% off</span> until you find a job.
                    </p>

                    {/* Price row as in Figma (static for design parity) */}
                    <div className="flex items-baseline justify-center gap-2 md:gap-3 mb-2 leading-none">
                      <span className="font-sans text-[26px] md:text-[16px] font-bold" style={{ color: COLORS.accent }}>$12.50/month</span>
                      <span className="font-sans text-[18px] md:text-[16px] font-normal text-gray-500 line-through ml-1">$25/month</span>
                    </div>

                    {/* Primary CTA */}
                    <button
                      onClick={async () => {
                        setAcceptedDownsell(true);
                        if (cancellationId) {
                          try { await supabase.from('cancellations').update({ accepted_downsell: true }).eq('id', cancellationId); } catch {}
                        }
                        setCurrentStep('downsell-accepted');
                      }}
                      className="w-full rounded-xl text-white text-[16px] font-sans font-semibold py-2.5 md:py-3 transition"
                      style={{ backgroundColor: hoverDownsellCTA ? COLORS.successStrong : COLORS.success }}
                      onMouseEnter={() => setHoverDownsellCTA(true)}
                      onMouseLeave={() => setHoverDownsellCTA(false)}
                    >
                      Get 50% off
                    </button>

                    {/* Footnote */}
                    <p className="mt-2 text-center text-[12px] md:text-[13px] font-sans font-normal italic text-gray-600 leading-tight">
                      You won't be charged until your next billing date.
                    </p>
                  </div>

                  {/* Divider to match Figma spacing */}
                  <hr className="my-4 border-t border-gray-200" />

                  {/* Secondary action */}
                  <button
                    onClick={() => setCurrentStep('using')}
                    className="w-full select-none touch-manipulation rounded-2xl border-2 border-gray-300 bg-white px-4 py-3 text-[16px] font-semibold text-gray-800 shadow-sm transition-colors md:hover:bg-rose-600 md:hover:border-rose-600 md:hover:text-white active:bg-rose-600 active:border-rose-600 active:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600"
                  >
                    No thanks
                  </button>
                </>
              )}

              {/* New 'using' step for still-looking path */}
              {currentStep === 'using' && (
                <>
                  <h3 className="text-[26px] md:text-[30px] font-extrabold text-gray-900 mb-3">
                    Help us understand how you were using Migrate Mate.
                  </h3>
                  <div className="space-y-5">
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">
                        How many roles did you apply for through Migrate Mate?*
                      </p>
                      <Segments options={['0','1-5','6-20','20+']} value={appliedCount} onChange={(v)=>setAppliedCount(v as any)} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">
                        How many companies did you email directly?*
                      </p>
                      <Segments options={['0','1-5','6-20','20+']} value={emailedCount} onChange={(v)=>setEmailedCount(v as any)} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">
                        How many different companies did you interview with?*
                      </p>
                      <Segments options={['0','1-2','3-5','5+']} value={interviewCount} onChange={(v)=>setInterviewCount(v as any)} />
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
                            setAcceptedDownsell(true);
                            if (cancellationId) {
                              try { await supabase.from('cancellations').update({ accepted_downsell: true }).eq('id', cancellationId); } catch {}
                            }
                            setCurrentStep('downsell-accepted');
                          }}
                        >
                          Get 50% off
                        </button>
                      </div>
                    )}
                    <div className="pt-2">
                      <button
                        disabled={!appliedCount || !emailedCount || !interviewCount}
                        className={
                          'rounded-2xl px-4 py-3 text-[15px] font-semibold ' +
                          (!appliedCount || !emailedCount || !interviewCount
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-rose-600 hover:bg-rose-700 text-white')
                        }
                        style={
                          (!appliedCount || !emailedCount || !interviewCount)
                            ? undefined
                            : undefined
                        }
                        onClick={() => {
                          if (appliedCount && emailedCount && interviewCount) setCurrentStep('reasons');
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
                  <h3 className="text-[26px] md:text-[28px] font-extrabold text-gray-900 mb-2">What’s the main reason for cancelling?</h3>
                  <p className="text-[14px] md:text-[15px] text-gray-600 mb-4">Please take a minute to let us know why.</p>

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
                          className="h-4 w-4 text-indigo-600"
                          checked={reasonChoice === (r.key as any)}
                          onChange={() => { setReasonChoice(r.key as any); setReasonTouched(true); }}
                        />
                        <span className="text-sm text-gray-800">{r.label}</span>
                      </label>
                    ))}
                  </div>

                  {/* Conditional inputs */}
                  {reasonChoice === 'too_expensive' ? (
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-gray-700 mb-1">What would be the maximum you’d be willing to pay?</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                        <input
                          type="text"
                          value={maxPrice}
                          onChange={(e) => setMaxPrice(e.target.value)}
                          className="w-full rounded-lg border border-gray-300 px-7 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white text-gray-900 placeholder-gray-400"
                        />
                      </div>
                    </div>
                  ) : reasonChoice ? (
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
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
                          className={`w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring-2 resize-none bg-white text-gray-900 placeholder-gray-400 ${reasonTouched && reasonText.trim().length < 25 ? 'border-red-400 focus:ring-red-300' : 'border-gray-300 focus:ring-violet-500'}`}
                        />
                        <div className="pointer-events-none absolute bottom-2 right-3 text-xs text-gray-500">Min 25 characters ({Math.min(reasonText.trim().length,25)}/25)</div>
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
                        setAcceptedDownsell(true);
                        if (cancellationId) {
                          try { await supabase.from('cancellations').update({ accepted_downsell: true }).eq('id', cancellationId); } catch {}
                        }
                        setCurrentStep('downsell-accepted');
                      }}
                    >
                      Get 50% off
                    </button>
                  )}

                  <button
                    disabled={!reasonChoice || (reasonChoice !== 'too_expensive' && reasonText.trim().length < 25)}
                    className={`w-full rounded-2xl px-4 py-3 text-[15px] font-semibold transition-colors ${!reasonChoice || (reasonChoice !== 'too_expensive' && reasonText.trim().length < 25) ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'text-white'}`}
                    style={!reasonChoice || (reasonChoice !== 'too_expensive' && reasonText.trim().length < 25) ? undefined : { backgroundColor: hoverCompleteCancel ? COLORS.brandStrong : COLORS.brand }}
                    onMouseEnter={() => { if (reasonChoice && (reasonChoice === 'too_expensive' || reasonText.trim().length >= 25)) setHoverCompleteCancel(true); }}
                    onMouseLeave={() => { if (reasonChoice && (reasonChoice === 'too_expensive' || reasonText.trim().length >= 25)) setHoverCompleteCancel(false); }}
                    onClick={async () => {
                      try {
                        if (cancellationId) {
                          const text = reasonChoice === 'too_expensive' ? (maxPrice ? `Too expensive; willing to pay $${maxPrice}` : 'Too expensive') : reasonText.trim();
                          await supabase.from('cancellations').update({ reason: text || null }).eq('id', cancellationId);
                        }
                      } catch {}
                      setVisaHasLawyer(false); // route to the generic "all sorted" completion
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
                    <h3 className="text-[26px] md:text-[28px] font-semibold text-gray-900 mb-2">
                      Great choice, mate!
                    </h3>
                    <p className="text-[16px] md:text-[18px] text-gray-800 mb-4 leading-snug">
                      You’re still on the path to your dream role.{' '}
                      <span className="font-semibold" style={{ color: COLORS.brand }}>Let’s make it happen together!</span>
                    </p>
                    <div className="space-y-1.5 text-[13px] md:text-[14px] text-gray-700">
                      <p>You’ve got XX days left on your current plan.</p>
                      <p>Starting from XX date, your monthly payment will be <span className="font-medium">$12.50</span>.</p>
                      <p className="text-gray-500 italic">You can cancel anytime before then.</p>
                    </div>
                  </div>
                  <div className="pt-4">
                    <hr className="mb-4 border-t border-gray-200" />
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
                  <h3 className="text-[28px] md:text-[30px] font-extrabold text-gray-900 mb-3">
                    What’s one thing you wish we could’ve helped you with?
                  </h3>

                  <p className="text-[14px] md:text-[15px] text-gray-600 mb-4">
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
                            : 'border-gray-300 focus:ring-violet-500')
                        }
                        rows={5}
                      />
                      <div className="pointer-events-none absolute bottom-2 right-3 text-xs text-gray-500">
                        Min {MIN_FEEDBACK} characters ({Math.min(feedback.trim().length, MIN_FEEDBACK)}/{MIN_FEEDBACK})
                      </div>
                    </div>

                    {/* Optional green CTA for still-looking + B variant + not accepted */}

                    <div className="mt-4 flex items-center gap-3">
                      <button
                        onClick={() => setCurrentStep(selectedOption === 'found-job' ? 'job-status' : 'initial')}
                        className="px-6 py-3 text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                      >
                        Back
                      </button>
                      <button
                        onClick={handleFeedbackSubmit}
                        disabled={feedback.trim().length < MIN_FEEDBACK}
                        className={
                          'flex-1 px-6 py-3 rounded-lg font-semibold transition-colors ' +
                          (feedback.trim().length < MIN_FEEDBACK
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'text-white')
                        }
                        style={feedback.trim().length < MIN_FEEDBACK ? undefined : { backgroundColor: hoverFeedbackContinue ? COLORS.brandStrong : COLORS.brand }}
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
                  <h3 className="text-[26px] md:text-[28px] font-extrabold text-gray-900 leading-tight mb-2">
                    {attributedToMM
                      ? "We helped you land the job, now let’s help you secure your visa."
                      : "You landed the job! That's what we live for."}
                  </h3>

                  {!attributedToMM && (
                    <p className="text-[15px] text-gray-700 mb-6">
                      Even if it wasn’t through Migrate Mate, let us help get your visa sorted.
                    </p>
                  )}

                  <div className="space-y-5">
                    <p className="text-sm font-medium text-gray-700">
                      Is your company providing an immigration lawyer to help with your visa?*
                    </p>

                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setVisaHasLawyer(true)}
                        className={'rounded-lg border px-4 py-2 text-sm font-medium transition ' +
                          (visaHasLawyer === true
                            ? 'border-indigo-600 bg-indigo-600 text-white'
                            : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400')}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisaHasLawyer(false)}
                        className={'rounded-lg border px-4 py-2 text-sm font-medium transition ' +
                          (visaHasLawyer === false
                            ? 'border-indigo-600 bg-indigo-600 text-white'
                            : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400')}
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
                            <label className="block text-sm font-medium text-gray-700">
                              What visa will you be applying for?*
                            </label>
                            <input
                              type="text"
                              value={visaType}
                              onChange={(e) => setVisaType(e.target.value)}
                              placeholder="e.g., H‑1B, O‑1, E‑3, TN…"
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white text-gray-900 placeholder-gray-400"
                            />
                          </>
                        ) : (
                          // NO: connect with trusted partners
                          <>
                            <p className="text-sm text-gray-700">
                              We can connect you with one of our trusted partners.
                            </p>
                            <label className="block text-sm font-medium text-gray-700">
                              Which visa would you like to apply for?*
                            </label>
                            <input
                              type="text"
                              value={visaType}
                              onChange={(e) => setVisaType(e.target.value)}
                              placeholder="e.g., H‑1B, O‑1, E‑3, TN…"
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white text-gray-900 placeholder-gray-400"
                            />
                          </>
                        )}
                      </div>
                    )}

                    <div className="pt-2">
                      <button
                        onClick={async () => {
                          try {
                            if (cancellationId) {
                              await supabase
                                .from('cancellations')
                                .update({
                                  visa_has_lawyer: visaHasLawyer,
                                  visa_type: visaType.trim() || null,
                                })
                                .eq('id', cancellationId);
                            }
                          } catch (e) {
                            console.error('Failed to persist visa info', e);
                          }
                          setCurrentStep('completed');
                        }}
                        disabled={visaHasLawyer === null || visaType.trim() === ''}
                        className={'w-full rounded-2xl px-4 py-3 text-[15px] font-semibold transition-colors ' +
                          (visaHasLawyer === null || visaType.trim() === ''
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'text-white')}
                        style={
                          visaHasLawyer === null || visaType.trim() === ''
                            ? undefined
                            : { backgroundColor: hoverCompleteCancel ? COLORS.brandStrong : COLORS.brand }
                        }
                        onMouseEnter={() => { if (!(visaHasLawyer === null || visaType.trim() === '')) setHoverCompleteCancel(true); }}
                        onMouseLeave={() => { if (!(visaHasLawyer === null || visaType.trim() === '')) setHoverCompleteCancel(false); }}
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
                      <h3 className="text-[24px] md:text-[26px] font-extrabold text-gray-900 leading-tight">Sorry to see you go, mate.</h3>
                      <div className="space-y-2 text-gray-800">
                        <p className="text-[16px] md:text-[18px] font-semibold">Thanks for being with us, and you’re always welcome back.</p>
                        <div className="text-sm text-gray-700">
                          <p>Your subscription is set to end on XX date.</p>
                          <p>You’ll still have full access until then. No further charges after that.</p>
                        </div>
                        <p className="text-xs md:text-sm text-gray-500">Changed your mind? You can reactivate anytime before your end date.</p>
                      </div>
                      <div className="pt-2">
                        <button
                          onClick={handleClose}
                          className="w-full rounded-2xl px-4 py-3 text-[15px] font-semibold text-white transition-colors"
                          style={{ backgroundColor: hoverFinish1 ? COLORS.brandStrong : COLORS.brand }}
                          onMouseEnter={() => setHoverFinish1(true)}
                          onMouseLeave={() => setHoverFinish1(false)}
                        >
                          Back to Jobs
                        </button>
                      </div>
                    </>
                  ) : visaHasLawyer === true ? (
                    <>
                      <h3 className="text-[22px] md:text-[24px] font-extrabold text-gray-900 leading-tight">All done, your cancellation’s been processed.</h3>
                      <p className="text-sm md:text-[15px] text-gray-700">We’re stoked to hear you’ve landed a job and sorted your visa. Big congrats from the team. 🙌</p>
                      <div className="pt-2">
                        <button
                          onClick={handleClose}
                          className="w-full rounded-2xl px-4 py-3 text-[15px] font-semibold text-white transition-colors"
                          style={{ backgroundColor: hoverFinish1 ? COLORS.brandStrong : COLORS.brand }}
                          onMouseEnter={() => setHoverFinish1(true)}
                          onMouseLeave={() => setHoverFinish1(false)}
                        >
                          Finish
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h3 className="text-[22px] md:text-[24px] font-extrabold text-gray-900 leading-tight">Your cancellation’s all sorted, mate, no more charges.</h3>
                      <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-gray-700 text-sm">
                        <p>We’ll be reaching out soon to help with the visa side of things.</p>
                        <p className="mt-1">We’ve got your back, whether it’s questions, paperwork, or just figuring out your options.</p>
                        <p className="mt-1 text-gray-500">Keep an eye on your inbox, we’ll be in touch shortly.</p>
                      </div>
                      <div className="pt-2">
                        <button
                          onClick={handleClose}
                          className="w-full rounded-2xl px-4 py-3 text-[15px] font-semibold text-white transition-colors"
                          style={{ backgroundColor: hoverFinish2 ? COLORS.brandStrong : COLORS.brand }}
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
          <div className={`order-1 md:order-2 ${currentStep==='downsell-accepted' ? 'p-4 md:p-6' : 'p-5 md:p-4'} flex`}>
            <div className={`relative w-full ${currentStep==='downsell-accepted' ? 'h-52 sm:h-60 md:h-[400px]' : 'h-48 sm:h-56 md:h-[380px]'} overflow-hidden rounded-2xl ring-1 ring-black/10 shadow-sm`}>
              <img
                src="/empire-state-compressed.jpg"
                alt="New York City Skyline with Empire State Building"
                className={`absolute inset-0 h-full w-full object-cover ${currentStep==='downsell-accepted' ? 'object-center md:scale-[1.08]' : 'object-center'}`}
                onLoad={() => {
                  // Image loaded
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}