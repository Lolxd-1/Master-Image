/**
 * Direct-manipulation stepper (production v2, Phase 3).
 *
 * Replaces the worst part of the app — a modal with stacked text fields and a keyboard —
 * for the four numbers a shopkeeper actually fixes on the fly: selling price, MRP, and the
 * two halves of a pack size. Minus on the left, plus on the right, the value in the middle;
 * tap for one step, press-and-hold to accelerate, or drag the value left/right to scrub.
 *
 * This file is a self-contained, dependency-free component: two other screens mount it,
 * so everything below `createStepper` is the contract they build against — keep it exact.
 */

import './stepper.css';

export interface StepperOptions {
  value: number;
  min: number;
  max: number;
  /** Fixed increment, or a function of the current value for adaptive steps. */
  step: number | ((v: number) => number);
  /** Decimal places kept — every value is rounded to this, so floats never drift. Default 0. */
  decimals?: number;
  /** Display formatter, e.g. (v) => '₹' + v.toLocaleString('en-IN'). Default String(v). */
  format?: (v: number) => string;
  /** Accessible name, e.g. "Selling price". Required. */
  label: string;
  size?: 'lg' | 'sm';
  /** Fires on EVERY value change — use it to update surrounding UI live. */
  onInput?: (v: number) => void;
  /** Fires when the interaction settles (release, typed value, or 500 ms idle). Persist here. */
  onCommit?: (v: number) => void;
  hint?: string;
  /** Tap the value to type an exact number. Default true. */
  allowType?: boolean;
}

export interface StepperHandle {
  readonly el: HTMLElement;
  getValue(): number;
  setValue(v: number, silent?: boolean): void;
  setRange(min: number, max: number): void;
  setHint(text: string): void;
  setFormat(fn: (v: number) => string): void;
  flushCommit(): void;
  destroy(): void;
}

const COMMIT_IDLE_MS = 500;
const HOLD_DELAY_MS = 400;
const SCRUB_PX_PER_STEP = 14;
const SCRUB_HORIZONTAL_THRESHOLD = 8;
const SCRUB_VERTICAL_THRESHOLD = 12;
const TAP_MAX_MOVE_PX = 4;
const TAP_MAX_DURATION_MS = 400;
const HAPTIC_SCRUB_MIN_INTERVAL_MS = 40;

function repeatDelayForTick(tick: number): number {
  if (tick <= 6) return 220;
  if (tick <= 16) return 90;
  return 45;
}

function repeatMultiplierForTick(tick: number): number {
  if (tick <= 8) return 1;
  if (tick <= 24) return 5;
  return 10;
}

function vibrate(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported / blocked — steppers work fine without haptics */
  }
}

// Explicit width/height: an <svg> with only a viewBox has no intrinsic size and renders at the
// UA default (300x150) otherwise (same trap noted in deck.ts / admin.ts / export.ts).
const ICON_MINUS =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>';
const ICON_PLUS =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

type DragPhase = 'idle' | 'down' | 'horizontal' | 'vertical';

export function createStepper(opts: StepperOptions): StepperHandle {
  const size = opts.size ?? 'lg';
  const decimals = opts.decimals ?? 0;
  const allowType = opts.allowType ?? true;
  const roundFactor = Math.pow(10, decimals);

  let formatFn = opts.format ?? ((v: number) => String(v));
  let min = opts.min;
  let max = opts.max;
  let destroyed = false;

  function round(v: number): number {
    return Math.round(v * roundFactor) / roundFactor;
  }
  function clampVal(v: number): number {
    return Math.min(max, Math.max(min, v));
  }
  function currentStep(v: number): number {
    return typeof opts.step === 'function' ? opts.step(v) : opts.step;
  }

  let value = round(clampVal(opts.value));
  let lastCommitted = value;

  // ---------------------------------------------------------------- DOM

  const root = document.createElement('div');
  root.className = 'stepper-wrap';
  root.dataset.size = size;

  const stepperEl = document.createElement('div');
  stepperEl.className = 'stepper';

  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.className = 'stepper__btn stepper__btn--minus';
  minusBtn.setAttribute('aria-label', `Decrease ${opts.label}`);
  minusBtn.tabIndex = -1;
  minusBtn.innerHTML = ICON_MINUS;

  const track = document.createElement('div');
  track.className = 'stepper__track';
  track.setAttribute('role', 'spinbutton');
  track.tabIndex = 0;
  track.setAttribute('aria-label', opts.label);

  const valueSpan = document.createElement('span');
  valueSpan.className = 'stepper__value';
  track.appendChild(valueSpan);

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'stepper__btn stepper__btn--plus';
  plusBtn.setAttribute('aria-label', `Increase ${opts.label}`);
  plusBtn.tabIndex = -1;
  plusBtn.innerHTML = ICON_PLUS;

  stepperEl.append(minusBtn, track, plusBtn);

  const hintEl = document.createElement('p');
  hintEl.className = 'stepper__hint';
  hintEl.textContent = opts.hint ?? '';

  root.append(stepperEl, hintEl);

  // ---------------------------------------------------------------- listener bookkeeping

  const disposers: Array<() => void> = [];
  function on<T extends Event>(
    target: EventTarget,
    type: string,
    handler: (ev: T) => void,
  ): void {
    const listener = handler as EventListener;
    target.addEventListener(type, listener);
    disposers.push(() => target.removeEventListener(type, listener));
  }

  // ---------------------------------------------------------------- render

  function render(): void {
    const text = formatFn(value);
    valueSpan.textContent = text;
    track.setAttribute('aria-valuenow', String(value));
    track.setAttribute('aria-valuemin', String(min));
    track.setAttribute('aria-valuemax', String(max));
    track.setAttribute('aria-valuetext', text);
    minusBtn.disabled = value <= min;
    plusBtn.disabled = value >= max;
  }

  // ---------------------------------------------------------------- commit / input plumbing

  let commitTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleCommit(): void {
    if (commitTimer !== undefined) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      commitTimer = undefined;
      commitNow();
    }, COMMIT_IDLE_MS);
  }

  function commitNow(): void {
    if (commitTimer !== undefined) {
      clearTimeout(commitTimer);
      commitTimer = undefined;
    }
    if (value === lastCommitted) return;
    lastCommitted = value;
    opts.onCommit?.(value);
  }

  /** The one path every gesture (tap, hold tick, scrub move, keyboard, typed entry) goes through. */
  function applyValue(raw: number, silent: boolean): void {
    const next = round(clampVal(raw));
    const changed = next !== value;
    value = next;
    render();
    if (silent) {
      lastCommitted = value;
      if (commitTimer !== undefined) {
        clearTimeout(commitTimer);
        commitTimer = undefined;
      }
      return;
    }
    if (changed) {
      opts.onInput?.(value);
      scheduleCommit();
    }
  }

  function applyStep(dir: 1 | -1, multiplier: number): void {
    applyValue(value + dir * currentStep(value) * multiplier, false);
  }

  // ---------------------------------------------------------------- press-and-hold

  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let repeatTimer: ReturnType<typeof setTimeout> | undefined;
  let isHolding = false;

  function beginHold(dir: 1 | -1): void {
    vibrate(8);
    applyStep(dir, 1); // the tap itself
    holdTimer = setTimeout(() => {
      isHolding = true;
      let tick = 0;
      const step = (): void => {
        tick++;
        applyStep(dir, repeatMultiplierForTick(tick));
        repeatTimer = setTimeout(step, repeatDelayForTick(tick));
      };
      step();
    }, HOLD_DELAY_MS);
  }

  // Single choke point for every way a hold must end. A stuck repeat timer that keeps
  // incrementing after the finger (or the whole page) is gone is the worst bug this
  // component can have, so every stop path — release, cancel, leaving the button, the
  // window losing focus, the tab going to the background, and destroy() — funnels here.
  function stopRepeat(): void {
    if (holdTimer !== undefined) {
      clearTimeout(holdTimer);
      holdTimer = undefined;
    }
    if (repeatTimer !== undefined) {
      clearTimeout(repeatTimer);
      repeatTimer = undefined;
    }
    const wasHolding = isHolding;
    isHolding = false;
    if (wasHolding) commitNow();
  }

  function attachHoldable(btn: HTMLButtonElement, dir: 1 | -1): void {
    on<PointerEvent>(btn, 'pointerdown', (e) => {
      if (btn.disabled) return;
      e.preventDefault();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      beginHold(dir);
    });
    on(btn, 'pointerup', stopRepeat);
    on(btn, 'pointercancel', stopRepeat);
    on(btn, 'pointerleave', stopRepeat);
  }
  attachHoldable(minusBtn, -1);
  attachHoldable(plusBtn, 1);

  // ---------------------------------------------------------------- scrub + tap-to-type

  let phase: DragPhase = 'idle';
  let activePointerId: number | null = null;
  let downX = 0;
  let downY = 0;
  let downTime = 0;
  let dragStartValue = 0;
  let lastHapticAt = 0;
  let inputEl: HTMLInputElement | null = null;

  function cancelScrub(): void {
    if (activePointerId !== null) {
      try {
        track.releasePointerCapture(activePointerId);
      } catch {
        /* already released */
      }
    }
    phase = 'idle';
    activePointerId = null;
    root.classList.remove('stepper--dragging');
  }

  on<PointerEvent>(track, 'pointerdown', (e) => {
    if (inputEl) return; // typing takes over the track; ignore drag starts
    phase = 'down';
    activePointerId = e.pointerId;
    downX = e.clientX;
    downY = e.clientY;
    downTime = Date.now();
    dragStartValue = value;
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
  });

  on<PointerEvent>(track, 'pointermove', (e) => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    if (phase === 'idle' || phase === 'vertical') return;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (phase === 'down') {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > SCRUB_VERTICAL_THRESHOLD) {
        // Vertical first — this is a page scroll, not a scrub. Let go entirely.
        cancelScrub();
        return;
      }
      if (Math.abs(dx) > SCRUB_HORIZONTAL_THRESHOLD) {
        phase = 'horizontal';
        root.classList.add('stepper--dragging');
      } else {
        return;
      }
    }
    if (e.cancelable) e.preventDefault();
    const steps = Math.round(dx / SCRUB_PX_PER_STEP);
    const next = round(clampVal(dragStartValue + steps * currentStep(dragStartValue)));
    if (next !== value) {
      applyValue(next, false);
      const now = Date.now();
      if (now - lastHapticAt >= HAPTIC_SCRUB_MIN_INTERVAL_MS) {
        lastHapticAt = now;
        vibrate(5);
      }
    }
  });

  on<PointerEvent>(track, 'pointerup', (e) => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    const wasHorizontal = phase === 'horizontal';
    const wasDown = phase === 'down';
    const totalMove = Math.hypot(e.clientX - downX, e.clientY - downY);
    const duration = Date.now() - downTime;
    try {
      track.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    root.classList.remove('stepper--dragging');
    phase = 'idle';
    activePointerId = null;
    if (wasHorizontal) {
      commitNow();
      return;
    }
    const wasCleanTap = wasDown && totalMove < TAP_MAX_MOVE_PX && duration < TAP_MAX_DURATION_MS;
    if (wasCleanTap && allowType) startTyping();
  });

  on<PointerEvent>(track, 'pointercancel', (e) => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    cancelScrub();
  });

  // Never let a parent see this gesture: the product card underneath owns a swipe-left/
  // right yes/no handler on itself, and a stepper drag must never be mistaken for a card
  // swipe. Stopping propagation at the wrapper root — above our own listeners, which are
  // already bound directly to the buttons/track — is enough to keep it from bubbling out.
  on(root, 'pointerdown', (e) => {
    e.stopPropagation();
  });

  // ---------------------------------------------------------------- keyboard

  on<KeyboardEvent>(track, 'keydown', (e) => {
    const s = currentStep(value);
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault();
        applyValue(value + s, false);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault();
        applyValue(value - s, false);
        break;
      case 'PageUp':
        e.preventDefault();
        applyValue(value + s * 10, false);
        break;
      case 'PageDown':
        e.preventDefault();
        applyValue(value - s * 10, false);
        break;
      case 'Home':
        e.preventDefault();
        applyValue(min, false);
        break;
      case 'End':
        e.preventDefault();
        applyValue(max, false);
        break;
      default:
        break;
    }
  });

  // ---------------------------------------------------------------- tap-to-type

  function endTyping(): void {
    if (!inputEl) return;
    const el = inputEl;
    inputEl = null;
    el.replaceWith(valueSpan);
    render();
  }

  function commitTyped(): void {
    if (!inputEl) return;
    const raw = inputEl.value.trim();
    endTyping();
    if (raw === '') return; // unparseable — revert silently
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return; // unparseable — revert silently
    applyValue(parsed, false);
    commitNow();
  }

  function cancelTyped(): void {
    if (!inputEl) return;
    endTyping();
  }

  function startTyping(): void {
    if (inputEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'stepper__input';
    input.setAttribute('aria-label', opts.label);
    input.value = String(value);
    valueSpan.replaceWith(input);
    inputEl = input;
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTyped();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelTyped();
      }
    });
    input.addEventListener('blur', () => commitTyped());
  }

  // ---------------------------------------------------------------- global "stop dead" hooks

  on(window, 'blur', () => {
    stopRepeat();
    cancelScrub();
  });
  on(document, 'visibilitychange', () => {
    if (document.hidden) {
      stopRepeat();
      cancelScrub();
    }
  });

  render();

  return {
    el: root,
    getValue(): number {
      return value;
    },
    setValue(v: number, silent = false): void {
      applyValue(v, silent);
    },
    setRange(newMin: number, newMax: number): void {
      min = newMin;
      max = newMax;
      // An external correction (e.g. MRP changed), not a user edit — re-clamp quietly.
      value = round(clampVal(value));
      lastCommitted = value;
      if (commitTimer !== undefined) {
        clearTimeout(commitTimer);
        commitTimer = undefined;
      }
      render();
    },
    setHint(text: string): void {
      hintEl.textContent = text;
    },
    setFormat(fn: (v: number) => string): void {
      formatFn = fn;
      render();
    },
    flushCommit(): void {
      commitNow();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stopRepeat();
      cancelScrub();
      if (commitTimer !== undefined) {
        clearTimeout(commitTimer);
        commitTimer = undefined;
      }
      for (const dispose of disposers) dispose();
      disposers.length = 0;
    },
  };
}
