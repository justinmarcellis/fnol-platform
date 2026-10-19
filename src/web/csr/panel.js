// Required-items panel view model and renderer. Pure logic: takes any document-like object.
// Items come from IntakeStep.missing[] (see assisted.js deriveMissing); the panel re-renders after every answer.

/** Rows for the panel: { text, current } plus a "more to come" count. */
export function panelModel(state, t) {
  const items = (state?.missing ?? []).map((m) => ({ id: m.id, text: m.text, current: state?.question?.id === m.id }));
  const unlisted = state?.unlisted ?? 0;
  return { items, unlisted, empty: !items.length && !unlisted, moreText: unlisted ? t('csr.panel.more', { count: unlisted }) : '', noneText: t('csr.panel.none') };
}

/** Replace the children of `ul` with the model's items. Uses textContent only. */
export function renderMissing(doc, ul, state, t) {
  const model = panelModel(state, t);
  ul.textContent = '';
  if (model.empty) {
    const li = doc.createElement('li'); li.textContent = model.noneText; ul.appendChild(li);
  }
  for (const m of model.items) {
    const li = doc.createElement('li'); li.textContent = m.text;
    if (m.current) li.setAttribute('aria-current', 'true');
    ul.appendChild(li);
  }
  return model;
}
