// Registers all kit custom elements. Safe to import in node (no-ops without a DOM).
import { FxField } from './field.js';
import { FxChips } from './chips.js';
import { FxStepper } from './stepper.js';
import { FxUpload } from './upload.js';
import { FxChat } from './chat.js';
import { FxTimeline } from './timeline.js';
import { FxToast } from './toast.js';
import { FxTable } from './table.js';

export { FxField, FxChips, FxStepper, FxUpload, FxChat, FxTimeline, FxToast, FxTable };

export const elements = {
  'fx-field': FxField, 'fx-chips': FxChips, 'fx-stepper': FxStepper, 'fx-upload': FxUpload,
  'fx-chat': FxChat, 'fx-timeline': FxTimeline, 'fx-toast': FxToast, 'fx-table': FxTable,
};

/** Define every element once. Returns the number newly defined (0 without a DOM). */
export function registerComponents(registry = globalThis.customElements) {
  if (!registry) return 0;
  let n = 0;
  for (const [name, cls] of Object.entries(elements)) {
    if (!registry.get(name)) { registry.define(name, cls); n++; }
  }
  return n;
}

registerComponents();
