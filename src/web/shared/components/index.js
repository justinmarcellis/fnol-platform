// Registers all kit custom elements. Safe to import in node (no-ops without a DOM).
import { FxField } from './field.js';
import { FxChips } from './chips.js';
import { FxStepper } from './stepper.js';
import { FxUpload } from './upload.js';
import { FxChat } from './chat.js';
import { FxTimeline } from './timeline.js';
import { FxToast } from './toast.js';
import { FxTable } from './table.js';
import { FxBadge } from './badge.js';
import { FxCard, FxEmptyState, FxSkeleton, FxStat } from './surfaces.js';
import { FxAppShell } from './app-shell.js';

export { FxField, FxChips, FxStepper, FxUpload, FxChat, FxTimeline, FxToast, FxTable };
export { FxBadge, FxCard, FxEmptyState, FxSkeleton, FxStat, FxAppShell };

/** The v1 kit (unchanged set; registerComponents keeps returning these for existing callers). */
export const elements = {
  'fx-field': FxField, 'fx-chips': FxChips, 'fx-stepper': FxStepper, 'fx-upload': FxUpload,
  'fx-chat': FxChat, 'fx-timeline': FxTimeline, 'fx-toast': FxToast, 'fx-table': FxTable,
};

/** Design system v2 additions (S6-EXP-01). */
export const elementsV2 = {
  'fx-badge': FxBadge, 'fx-card': FxCard, 'fx-empty-state': FxEmptyState, 'fx-skeleton': FxSkeleton,
  'fx-stat': FxStat, 'fx-app-shell': FxAppShell,
};

function define(registry, map) {
  if (!registry) return 0;
  let n = 0;
  for (const [name, cls] of Object.entries(map)) {
    if (!registry.get(name)) { registry.define(name, cls); n++; }
  }
  return n;
}

/** Define every v1 element once. Returns the number newly defined (0 without a DOM). */
export function registerComponents(registry = globalThis.customElements) {
  return define(registry, elements);
}

/** Define v1 and v2 elements once. Returns the number newly defined (0 without a DOM). */
export function registerAll(registry = globalThis.customElements) {
  return define(registry, elements) + define(registry, elementsV2);
}

registerAll();
