import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useId, useRef, useState } from 'react';
import { buildBugReportUrl } from './bugReport';

const BugReportDialog = () => {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState('');
  const [includeSystemDetails, setIncludeSystemDetails] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const stepsId = useId();
  const detailsId = useId();

  useEffect(() => {
    const unlisten = listen('cobble://report-bug', () => {
      previousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setError(null);
      setOpen(true);
    });

    return () => {
      void unlisten.then((stopListening) => stopListening());
    };
  }, []);

  useEffect(() => {
    if (!open) {
      previousFocusRef.current?.focus();
      return;
    }
    window.requestAnimationFrame(() => titleInputRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const submitReport = async () => {
    if (!title.trim() || !description.trim() || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const appVersion = await getVersion().catch(() => 'unknown');
      const reportUrl = buildBugReportUrl(
        { title, description, steps, includeSystemDetails },
        {
          appVersion,
          platform: navigator.platform || 'unknown',
          userAgent: navigator.userAgent || 'unknown',
          language: navigator.language || 'unknown',
          screen: `${window.screen.width} × ${window.screen.height} @ ${window.devicePixelRatio}x`,
        },
      );
      await openUrl(reportUrl);
      setOpen(false);
      setTitle('');
      setDescription('');
      setSteps('');
      setIncludeSystemDetails(true);
    } catch (submitError) {
      console.error('Failed to open the bug report:', submitError);
      setError('Cobble could not open the bug report in your browser.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center overflow-y-auto bg-background/70 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="window-no-drag my-auto w-full max-w-lg rounded-2xl border border-border bg-card p-4 shadow-lg"
      >
        <h1 id={titleId} className="text-lg font-semibold text-foreground">Report a bug</h1>
        <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">
          Cobble will open a prepared GitHub issue in your browser.
        </p>

        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitReport();
          }}
        >
          <label htmlFor={`${titleId}-input`} className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Title
          </label>
          <input
            ref={titleInputRef}
            id={`${titleId}-input`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            required
            placeholder="Briefly describe the problem"
            className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:outline-none"
          />

          <label htmlFor={`${descriptionId}-input`} className="mt-4 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            What happened?
          </label>
          <textarea
            id={`${descriptionId}-input`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={4_000}
            required
            rows={5}
            placeholder="Describe what you saw and what you expected"
            className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:outline-none"
          />

          <label htmlFor={`${stepsId}-input`} className="mt-4 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Steps to reproduce
          </label>
          <textarea
            id={`${stepsId}-input`}
            value={steps}
            onChange={(event) => setSteps(event.target.value)}
            maxLength={2_000}
            rows={3}
            placeholder="List the actions that caused the problem"
            className="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:outline-none"
          />

          <label htmlFor={detailsId} className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg bg-muted/30 px-3 py-2.5 transition-colors hover:bg-muted">
            <input
              id={detailsId}
              type="checkbox"
              checked={includeSystemDetails}
              onChange={(event) => setIncludeSystemDetails(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            />
            <span>
              <span className="block text-xs font-medium text-foreground">Include system details</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">Adds the Cobble version, macOS details, language, and screen size.</span>
            </span>
          </label>

          {error ? <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground active:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || !description.trim() || submitting}
              aria-busy={submitting ? true : undefined}
              className="rounded-lg border border-border bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground active:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Opening…' : 'Continue in GitHub'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default BugReportDialog;
