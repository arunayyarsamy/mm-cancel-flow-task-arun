'use client';

import { useEffect, useRef, useState } from 'react';

type CancellationStep = 'initial' | 'job-status' | 'feedback' | 'confirmation' | 'completed';

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
  const MIN_FEEDBACK = 25;
  const [feedbackTouched, setFeedbackTouched] = useState(false);

  const scrollYRef = useRef(0);

  const totalSteps = 3;
  const getStepNumber = () => {
    switch (currentStep) {
      case 'job-status':
        return 1;
      case 'feedback':
        return 2;
      case 'confirmation':
        return 3;
      default:
        return 0; // initial has no number
    }
  };

  const handleBack = () => {
    if (currentStep === 'job-status') {
      setCurrentStep('initial');
    } else if (currentStep === 'feedback') {
      // if the user came from found-job, go back to job-status; otherwise to initial
      if (selectedOption === 'found-job') setCurrentStep('job-status');
      else setCurrentStep('initial');
    } else if (currentStep === 'confirmation') {
      setCurrentStep('feedback');
    }
  };

  const handleOptionSelect = (option: 'found-job' | 'still-looking') => {
    setSelectedOption(option);
    if (option === 'found-job') {
      setCurrentStep('job-status');
    } else {
      setCurrentStep('feedback');
    }
  };

  const handleFeedbackSubmit = () => {
    // Here you would typically send this data to your backend
    console.log('User selected:', selectedOption);
    console.log('User feedback:', feedback);
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

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
            {/* Back (left) */}
            {currentStep !== 'initial' ? (
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
              <p className="text-[16px] md:text-[17px] font-semibold text-gray-900">{currentStep === 'completed' ? 'Subscription Cancelled' : 'Subscription Cancellation'}</p>
              {(currentStep === 'job-status' || currentStep === 'feedback' || currentStep === 'confirmation' || currentStep === 'completed') && (
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
          <div className="order-2 md:order-1 p-5 md:p-6 flex flex-col justify-center">
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
                      className="w-full select-none touch-manipulation rounded-2xl border border-gray-300 bg-white px-4 py-3 text-[15px] font-medium text-gray-800 shadow-sm transition-colors md:hover:bg-indigo-600 md:hover:border-indigo-600 md:hover:text-white active:bg-indigo-600 active:border-indigo-600 active:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
                    >
                      Yes, I’ve found a job
                    </button>

                    <button
                      onClick={() => handleOptionSelect('still-looking')}
                      className="w-full select-none touch-manipulation rounded-2xl border border-gray-300 bg-white px-4 py-3 text-[15px] font-medium text-gray-800 shadow-sm transition-colors md:hover:bg-indigo-600 md:hover:border-indigo-600 md:hover:text-white active:bg-indigo-600 active:border-indigo-600 active:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
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
                            : 'bg-indigo-600 text-white hover:bg-indigo-500')
                        }
                      >
                        Continue
                      </button>
                    </div>
                  </div>
                </>
              )}

              {currentStep === 'feedback' && (
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
                          `w-full px-4 py-3 border rounded-lg focus:ring-2 focus:border-transparent resize-none ` +
                          (feedbackTouched && feedback.trim().length < MIN_FEEDBACK
                            ? 'border-red-400 focus:ring-red-300'
                            : 'border-gray-300 focus:ring-[#8952fc]')
                        }
                        rows={5}
                      />
                      <div className="pointer-events-none absolute bottom-2 right-3 text-xs text-gray-500">
                        Min {MIN_FEEDBACK} characters ({Math.min(feedback.trim().length, MIN_FEEDBACK)}/{MIN_FEEDBACK})
                      </div>
                    </div>

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
                            : 'bg-[#8952fc] text-white hover:bg-[#7b40fc]')
                        }
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
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                          </>
                        )}
                      </div>
                    )}

                    <div className="pt-2">
                      <button
                        onClick={() => { setCurrentStep('completed'); }}
                        disabled={visaHasLawyer === null || visaType.trim() === ''}
                        className={'w-full rounded-2xl px-4 py-3 text-[15px] font-semibold transition-colors ' +
                          (visaHasLawyer === null || visaType.trim() === ''
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-indigo-600 text-white hover:bg-indigo-500')}
                      >
                        Complete cancellation
                      </button>
                    </div>
                  </div>
                </>
              )}

              {currentStep === 'completed' && (
                <>
                  {visaHasLawyer ? (
                    <div className="space-y-4">
                      <h3 className="text-[24px] md:text-[26px] font-extrabold text-gray-900 leading-tight">
                        All done, your cancellation’s been processed.
                      </h3>
                      <p className="text-sm text-gray-700">
                        We’re stoked to hear you’ve landed a job and sorted your visa. Big congrats from the team. 🙌
                      </p>
                      <div className="pt-2">
                        <button onClick={handleClose} className="w-full rounded-2xl px-4 py-3 text-[15px] font-semibold bg-[#8952fc] text-white hover:bg-[#7b40fc] transition-colors">Finish</button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      <h3 className="text-[24px] md:text-[26px] font-extrabold text-gray-900 leading-tight">
                        Your cancellation’s all sorted, mate, no more charges.
                      </h3>
                      <div className="rounded-xl border border-gray-200 p-4 flex items-start gap-3 bg-white">
                        <img src="/avatar-placeholder.png" alt="Visa advisor" className="h-10 w-10 rounded-full object-cover" onError={(e)=>{ (e.currentTarget as HTMLImageElement).style.display='none'; }} />
                        <div className="text-sm text-gray-700">
                          <p className="font-medium">Mihela Basic</p>
                          <p className="text-gray-500 mb-2">mihela@migratemate.co</p>
                          <p>I’ll be reaching out soon to help with the visa side of things. We’ve got your back, whether it’s questions, paperwork, or just figuring out your options. Keep an eye on your inbox; I’ll be in touch shortly.</p>
                        </div>
                      </div>
                      <div className="pt-1">
                        <button onClick={handleClose} className="w-full rounded-2xl px-4 py-3 text-[15px] font-semibold bg-[#8952fc] text-white hover:bg-[#7b40fc] transition-colors">Finish</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right Panel - Image (thumbnail card to match Figma) */}
          <div className="order-1 md:order-2 p-5 md:p-4 flex">
            <div className="relative w-full h-48 sm:h-56 md:h-full overflow-hidden rounded-2xl ring-1 ring-black/10 shadow-sm">
              <img
                src="/empire-state-compressed.jpg"
                alt="New York City Skyline with Empire State Building"
                className="absolute inset-0 h-full w-full object-cover object-center"
                onLoad={() => {
                  console.log('Image loaded successfully');
                  const el = document.querySelector('img[src="/empire-state-compressed.jpg"]') as HTMLImageElement | null;
                  console.log('Image dimensions:', el?.naturalWidth, 'x', el?.naturalHeight);
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );