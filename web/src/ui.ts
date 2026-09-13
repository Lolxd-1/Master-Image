/**
 * Shared toast + confirm primitives, plus small cross-screen helpers (production v2, Phase 1).
 *
 * One stack, one pattern: every screen reports transient success via `toast()`
 * (with optional Undo action) and every destructive action goes through `confirmDialog()`
 * which states the count. No screen invents its own inline pattern.
 *
 * Also home to three small primitives other screens depend on: `trapFocus` + `lockBodyScroll`
 * for any modal (confirm, sheets, menus), `renderStatusChip` so the sync chip is painted the
 * same everywhere, and `renderIncrementalList` so a list of thousands of product rows never
 * gets built synchronously on a cheap phone.
 */

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap Tab focus inside `el`, remember what was focused before. Returns a release fn that
 * restores it. Used by `confirmDialog` below and by any other modal (sheets, menus).
 */
export function trapFocus(el: HTMLElement): () => void {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  function focusable(): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  const first = focusable()[0];
  (first ?? el).focus();

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const items = focusable();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === firstEl || !el.contains(active)) {
        e.preventDefault();
        lastEl.focus();
      }
    } else if (active === lastEl || !el.contains(active)) {
      e.preventDefault();
      firstEl.focus();
    }
  }

  el.addEventListener('keydown', onKeydown);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    el.removeEventListener('keydown', onKeydown);
    previouslyFocused?.focus();
  };
}

let scrollLockCount = 0;
let savedBodyOverflow = '';

/**
 * Prevent the page behind a modal from scrolling. Returns a release fn. Safe to nest
 * (ref-counted) — a confirm dialog opened on top of a sheet does not unlock the page when
 * only the confirm closes.
 */
export function lockBodyScroll(): () => void {
  if (scrollLockCount === 0) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLockCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0) document.body.style.overflow = savedBodyOverflow;
  };
}

const STATUS_CHIP_TEXT: Record<'saving' | 'saved' | 'offline', { label: string; sentence: string }> = {
  saving: { label: 'Saving…', sentence: 'Saving — your changes are being sent.' },
  saved: { label: 'Saved', sentence: 'Saved — everything is up to date.' },
  offline: { label: 'Offline', sentence: 'Offline — your work is saved on this phone and will sync' },
};

/**
 * Paint the shared sync chip: short label + coloured dot + full sentence in aria-label/title.
 * The old chips wrote the long sentence as the visible label, which squeezed the deck's top
 * bar on a 360px screen — this keeps the visible text to one word.
 */
export function renderStatusChip(el: HTMLElement, status: 'saving' | 'saved' | 'offline'): void {
  const cfg = STATUS_CHIP_TEXT[status];
  el.textContent = '';
  el.dataset.status = status;
  const dot = document.createElement('span');
  dot.className = 'status-chip__dot';
  dot.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'status-chip__label';
  label.textContent = cfg.label;
  el.append(dot, label);
  el.setAttribute('aria-label', cfg.sentence);
  el.title = cfg.sentence;
}

export interface IncrementalListHandle {
  /** Stop observing/listening. Call this before re-rendering the container and on unmount. */
  destroy(): void;
  /** How many items are currently rendered — pass back as `initialCount` to resume at the same depth after a re-render. */
  renderedCount(): number;
}

/**
 * Renders `items` into `container` in batches (default 40) instead of all at once — search
 * results, review lists and the export item list can each be thousands of rows now, and
 * building them synchronously janks a cheap phone. Appends the next batch when a sentinel
 * scrolls into view (IntersectionObserver), or shows a "Show more" button when that API is
 * unavailable. The caller owns `container` and must call `destroy()` when the screen unmounts
 * or before re-rendering the same container, to avoid leaking the observer.
 */
export function renderIncrementalList<T>(
  container: HTMLElement,
  items: readonly T[],
  renderItem: (item: T) => HTMLElement,
  options: { readonly batchSize?: number; readonly initialCount?: number } = {},
): IncrementalListHandle {
  const batchSize = options.batchSize ?? 40;
  const supportsObserver = typeof IntersectionObserver !== 'undefined';

  const tail = document.createElement('div');
  tail.className = 'list-tail';
  container.appendChild(tail);

  const sentinel = document.createElement('div');
  sentinel.className = 'list-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');

  let showMoreBtn: HTMLButtonElement | null = null;
  let renderedCount = 0;
  let destroyed = false;

  function updateTail(): void {
    if (renderedCount >= items.length) {
      tail.hidden = true;
      tail.innerHTML = '';
      return;
    }
    tail.hidden = false;
    if (supportsObserver) {
      if (sentinel.parentElement !== tail) {
        tail.innerHTML = '';
        tail.appendChild(sentinel);
      }
    } else {
      tail.innerHTML = '';
      if (!showMoreBtn) {
        showMoreBtn = document.createElement('button');
        showMoreBtn.type = 'button';
        showMoreBtn.className = 'btn list-show-more';
        showMoreBtn.addEventListener('click', () => appendUpTo(renderedCount + batchSize));
      }
      showMoreBtn.textContent = `Show more (${items.length - renderedCount} left)`;
      tail.appendChild(showMoreBtn);
    }
  }

  function appendUpTo(n: number): void {
    const target = Math.min(Math.max(n, 0), items.length);
    if (target <= renderedCount) return;
    const frag = document.createDocumentFragment();
    for (let i = renderedCount; i < target; i++) frag.appendChild(renderItem(items[i]));
    container.insertBefore(frag, tail);
    renderedCount = target;
    updateTail();
  }

  let observer: IntersectionObserver | null = null;
  if (supportsObserver) {
    observer = new IntersectionObserver(
      (entries) => {
        if (destroyed) return;
        if (entries.some((e) => e.isIntersecting)) appendUpTo(renderedCount + batchSize);
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(sentinel);
  }

  appendUpTo(Math.min(items.length, Math.max(batchSize, options.initialCount ?? 0)));

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
    },
    renderedCount(): number {
      return renderedCount;
    },
  };
}

let stackEl: HTMLElement | null = null;

function ensureStack(): HTMLElement {
  if (stackEl && stackEl.isConnected) return stackEl;
  stackEl = document.createElement('div');
  stackEl.className = 'toast-stack';
  stackEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(stackEl);
  return stackEl;
}

/** Transient message, auto-dismissed. Returns a dismiss fn. */
export function toast(message: string, action?: ToastAction, ms = 6000): () => void {
  const stack = ensureStack();
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dismiss = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    el.remove();
  };
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    el.appendChild(btn);
  }
  stack.appendChild(el);
  timer = setTimeout(dismiss, ms);
  return dismiss;
}

/** Blocking confirm stating the outcome. Resolves true on confirm. */
export function confirmDialog(opts: {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'confirm-scrim';
    const box = document.createElement('div');
    box.className = 'confirm';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2');
    h.textContent = opts.title;
    const p = document.createElement('p');
    p.textContent = opts.body;
    const actions = document.createElement('div');
    actions.className = 'confirm__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = opts.cancelLabel ?? 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn btn-primary';
    okBtn.textContent = opts.confirmLabel;
    const done = (v: boolean): void => {
      releaseFocus();
      releaseScroll();
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') done(false);
    };
    cancel.addEventListener('click', () => done(false));
    okBtn.addEventListener('click', () => done(true));
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) done(false);
    });
    document.addEventListener('keydown', onKey, true);
    actions.append(cancel, okBtn);
    box.append(h, p, actions);
    scrim.appendChild(box);
    document.body.appendChild(scrim);
    const releaseScroll = lockBodyScroll();
    const releaseFocus = trapFocus(box);
    okBtn.focus(); // trapFocus already focused the first focusable element; the primary action wins here.
  });
}
