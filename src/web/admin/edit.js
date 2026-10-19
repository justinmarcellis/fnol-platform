// Pure edit operations on the admin console state ({cfg, localErrors, rawText, qSet, report}).
import {
  addItem, coerce, getAt, i18nGet, i18nSet, moveItem, newLob, newQuestion, newQuestionSet, newRule, newTimer, parseCsv, isLocale, removeItem, setAt,
} from './config-model.js';

/**
 * Apply one field edit. Invalid JSON/number input is kept in rawText and reported in localErrors
 * and the config is left unchanged for that field.
 * @returns {{structural:boolean}} structural = the form should be re-rendered
 */
export function applyFieldEdit(state, { pointer, kind, locale, raw }) {
  state.localErrors ??= {};
  state.rawText ??= {};
  const key = locale ? pointer : pointer;
  if (kind === 'i18n') {
    setAt(state.cfg, pointer, i18nSet(getAt(state.cfg, pointer), locale, String(raw ?? '')));
    return { structural: false };
  }
  const r = coerce(kind, raw);
  if (r.error) {
    state.localErrors[key] = r.error;
    if (kind === 'json') state.rawText[key] = String(raw ?? '');
    return { structural: false };
  }
  delete state.localErrors[key];
  delete state.rawText[key];
  let value = r.value;
  if (kind === 'csv' && pointer === '/locales') {
    const bad = (value ?? []).filter((l) => !isLocale(l));
    if (bad.length) { state.localErrors[key] = `Not a valid locale tag: ${bad.join(', ')}.`; state.rawText[key] = String(raw); return { structural: false }; }
    value ??= ['en'];
  }
  if (kind === 'text' && value === undefined && /\/(id|state|kind|stage|type|lob)$/.test(pointer)) value = '';
  setAt(state.cfg, pointer, value);
  return { structural: pointer === '/locales' || /\/type$/.test(pointer) };
}

const factory = (pointer, cfg) => {
  if (pointer === '/lobs') return newLob();
  if (pointer === '/questionSets') return newQuestionSet(cfg.lobs?.[0]?.id);
  if (pointer.endsWith('/questions')) return newQuestion(`question_${(getAt(cfg, pointer)?.length ?? 0) + 1}`);
  if (pointer === '/rules') return newRule();
  if (pointer === '/timers') return newTimer(cfg.timers?.[0]?.state);
  throw new Error(`No list at ${pointer}`);
};

/**
 * Add, remove or move a list item. Clears transient error state because pointers shift.
 * @param {'add'|'remove'|'up'|'down'} act
 */
export function applyListAction(state, act, pointer, index = 0) {
  if (act === 'add') {
    const i = addItem(state.cfg, pointer, factory(pointer, state.cfg));
    if (pointer === '/questionSets') state.qSet = i;
  } else if (act === 'remove') {
    removeItem(state.cfg, pointer, index);
    if (pointer === '/questionSets') state.qSet = Math.max(0, Math.min(state.qSet ?? 0, (state.cfg.questionSets?.length ?? 1) - 1));
  } else if (act === 'up') moveItem(state.cfg, pointer, index, -1);
  else if (act === 'down') moveItem(state.cfg, pointer, index, 1);
  else throw new Error(`Unknown list action ${act}`);
  state.localErrors = {};
  state.rawText = {};
  state.report = null;
}

export { parseCsv, i18nGet };
