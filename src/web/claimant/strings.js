// Claimant app string tables (en, es). Pure data: no kit imports.
// Keys are namespaced claimant.*; the kit registers common.* and kit.*.

/** @type {Record<string, Record<string, string>>} */
export const claimantStrings = {
  en: {
    'claimant.title': 'Report a claim',
    'claimant.skip': 'Skip to main content',
    'claimant.tenant.label': 'Insurance company',
    'claimant.lang.label': 'Language',
    'claimant.lang.en': 'English',
    'claimant.lang.es': 'Español',
    'claimant.loading': 'Loading…',
    'claimant.unavailable.title': 'Service unavailable',
    'claimant.unavailable.body': 'We could not reach the claims service. Your answers so far are safe. Please try again.',
    'claimant.unavailable.retry': 'Try again',
    'claimant.error.generic': 'Something went wrong: {message}',
    'claimant.start.heading': 'Tell us what happened',
    'claimant.start.intro': 'We will ask a few questions. You can finish in about five minutes.',
    'claimant.start.lob': 'What do you need to report?',
    'claimant.start.mode': 'How would you like to answer?',
    'claimant.start.guided': 'Guided questions',
    'claimant.start.guidedHelp': 'One question at a time.',
    'claimant.start.chat': 'Chat',
    'claimant.start.chatHelp': 'Describe it in your own words.',
    'claimant.start.go': 'Start',
    'claimant.start.noLobs': 'No lines of business are available for this company yet.',
    'claimant.guided.progress': '{answered} answered, {remaining} to go',
    'claimant.guided.next': 'Continue',
    'claimant.guided.skip': 'Skip',
    'claimant.guided.optional': '(optional)',
    'claimant.guided.required': 'Required',
    'claimant.guided.yes': 'Yes',
    'claimant.guided.no': 'No',
    'claimant.guided.acknowledge': 'I have read and understand',
    'claimant.review.heading': 'Ready to submit',
    'claimant.review.body': 'You have answered every required question.',
    'claimant.review.submit': 'Submit claim',
    'claimant.submitting': 'Submitting your claim…',
    'claimant.chat.heading': 'Chat with our claims assistant',
    'claimant.chat.log': 'Conversation',
    'claimant.chat.input': 'Your answer',
    'claimant.chat.send': 'Send',
    'claimant.chat.you': 'You',
    'claimant.chat.assistant': 'Assistant',
    'claimant.chat.pickOne': 'Please choose one of: {options}.',
    'claimant.chat.badNumber': 'Please enter a number.',
    'claimant.chat.badBoolean': 'Please answer yes or no.',
    'claimant.chat.empty': 'Please type an answer.',
    'claimant.chat.done': 'That is everything I need. You can submit your claim now.',
    'claimant.chat.suggested': 'I filled this in for you: {value}',
    'claimant.chat.confirm': 'Confirm',
    'claimant.chat.edit': 'Edit',
    'claimant.chat.save': 'Save',
    'claimant.chat.confirmed': 'Confirmed',
    'claimant.chat.ai': 'AI suggestion ({provider}, {model}), confidence {confidence}%',
    'claimant.chat.aiWhy': 'Why: {explanation}',
    'claimant.submitted.heading': 'Your claim has been received',
    'claimant.submitted.number': 'Claim number',
    'claimant.submitted.keep': 'Keep this number for your records.',
    'claimant.evidence.heading': 'Add photos and documents',
    'claimant.evidence.help': 'Photos, police reports, estimates or invoices help us move faster. Up to {max} MB each.',
    'claimant.evidence.kind': 'Type of document',
    'claimant.evidence.kind.photo': 'Photo',
    'claimant.evidence.kind.police_report': 'Police report',
    'claimant.evidence.kind.estimate': 'Estimate',
    'claimant.evidence.kind.invoice': 'Invoice',
    'claimant.evidence.kind.other': 'Other',
    'claimant.evidence.choose': 'Choose files',
    'claimant.evidence.uploading': 'Uploading {name}…',
    'claimant.evidence.done': '{name} uploaded',
    'claimant.evidence.failed': '{name} could not be uploaded',
    'claimant.evidence.tooLarge': '{name} is larger than {max} MB',
    'claimant.evidence.badType': '{name} is not a supported file type',
    'claimant.evidence.retry': 'Retry',
    'claimant.status.heading': 'Claim status',
    'claimant.status.updated': 'Last checked {time}',
    'claimant.status.refresh': 'Refresh now',
    'claimant.status.paused': 'Updates are paused while this page is hidden.',
    'claimant.status.final': 'This claim is {status}. We have stopped checking for updates.',
    'claimant.status.stale': 'We could not refresh the status. Retrying automatically.',
    'claimant.status.reported': 'Reported',
    'claimant.status.validating': 'Checking details',
    'claimant.status.triaged': 'Reviewed',
    'claimant.status.assigned': 'Adjuster assigned',
    'claimant.status.fast_tracked': 'Fast-tracked',
    'claimant.status.in_review': 'In review',
    'claimant.status.pending_info': 'We need more information',
    'claimant.status.closed': 'Closed',
    'claimant.status.withdrawn': 'Withdrawn',
    'claimant.status.current': 'Current step',
    'claimant.status.complete': 'Completed',
    'claimant.status.upcoming': 'Upcoming'
  },
  es: {
    'claimant.title': 'Reportar un reclamo',
    'claimant.skip': 'Saltar al contenido principal',
    'claimant.tenant.label': 'Compañía de seguros',
    'claimant.lang.label': 'Idioma',
    'claimant.lang.en': 'English',
    'claimant.lang.es': 'Español',
    'claimant.loading': 'Cargando…',
    'claimant.unavailable.title': 'Servicio no disponible',
    'claimant.unavailable.body': 'No pudimos comunicarnos con el servicio de reclamos. Sus respuestas hasta ahora están a salvo. Inténtelo de nuevo.',
    'claimant.unavailable.retry': 'Intentar de nuevo',
    'claimant.error.generic': 'Algo salió mal: {message}',
    'claimant.start.heading': 'Cuéntenos qué pasó',
    'claimant.start.intro': 'Le haremos algunas preguntas. Puede terminar en unos cinco minutos.',
    'claimant.start.lob': '¿Qué necesita reportar?',
    'claimant.start.mode': '¿Cómo prefiere responder?',
    'claimant.start.guided': 'Preguntas guiadas',
    'claimant.start.guidedHelp': 'Una pregunta a la vez.',
    'claimant.start.chat': 'Chat',
    'claimant.start.chatHelp': 'Descríbalo con sus propias palabras.',
    'claimant.start.go': 'Comenzar',
    'claimant.start.noLobs': 'Todavía no hay líneas de negocio disponibles para esta compañía.',
    'claimant.guided.progress': '{answered} respondidas, faltan {remaining}',
    'claimant.guided.next': 'Continuar',
    'claimant.guided.skip': 'Omitir',
    'claimant.guided.optional': '(opcional)',
    'claimant.guided.required': 'Obligatorio',
    'claimant.guided.yes': 'Sí',
    'claimant.guided.no': 'No',
    'claimant.guided.acknowledge': 'He leído y entiendo',
    'claimant.review.heading': 'Listo para enviar',
    'claimant.review.body': 'Ha respondido todas las preguntas obligatorias.',
    'claimant.review.submit': 'Enviar reclamo',
    'claimant.submitting': 'Enviando su reclamo…',
    'claimant.chat.heading': 'Chatee con nuestro asistente de reclamos',
    'claimant.chat.log': 'Conversación',
    'claimant.chat.input': 'Su respuesta',
    'claimant.chat.send': 'Enviar',
    'claimant.chat.you': 'Usted',
    'claimant.chat.assistant': 'Asistente',
    'claimant.chat.pickOne': 'Elija una de estas opciones: {options}.',
    'claimant.chat.badNumber': 'Ingrese un número.',
    'claimant.chat.badBoolean': 'Responda sí o no.',
    'claimant.chat.empty': 'Escriba una respuesta.',
    'claimant.chat.done': 'Eso es todo lo que necesito. Ya puede enviar su reclamo.',
    'claimant.chat.suggested': 'Completé esto por usted: {value}',
    'claimant.chat.confirm': 'Confirmar',
    'claimant.chat.edit': 'Editar',
    'claimant.chat.save': 'Guardar',
    'claimant.chat.confirmed': 'Confirmado',
    'claimant.chat.ai': 'Sugerencia de IA ({provider}, {model}), confianza {confidence}%',
    'claimant.chat.aiWhy': 'Motivo: {explanation}',
    'claimant.submitted.heading': 'Recibimos su reclamo',
    'claimant.submitted.number': 'Número de reclamo',
    'claimant.submitted.keep': 'Guarde este número para sus registros.',
    'claimant.evidence.heading': 'Agregue fotos y documentos',
    'claimant.evidence.help': 'Las fotos, informes policiales, presupuestos o facturas nos ayudan a avanzar más rápido. Hasta {max} MB cada uno.',
    'claimant.evidence.kind': 'Tipo de documento',
    'claimant.evidence.kind.photo': 'Foto',
    'claimant.evidence.kind.police_report': 'Informe policial',
    'claimant.evidence.kind.estimate': 'Presupuesto',
    'claimant.evidence.kind.invoice': 'Factura',
    'claimant.evidence.kind.other': 'Otro',
    'claimant.evidence.choose': 'Elegir archivos',
    'claimant.evidence.uploading': 'Subiendo {name}…',
    'claimant.evidence.done': '{name} subido',
    'claimant.evidence.failed': 'No se pudo subir {name}',
    'claimant.evidence.tooLarge': '{name} supera {max} MB',
    'claimant.evidence.badType': '{name} no es un tipo de archivo admitido',
    'claimant.evidence.retry': 'Reintentar',
    'claimant.status.heading': 'Estado del reclamo',
    'claimant.status.updated': 'Última revisión {time}',
    'claimant.status.refresh': 'Actualizar ahora',
    'claimant.status.paused': 'Las actualizaciones están en pausa mientras esta página está oculta.',
    'claimant.status.final': 'Este reclamo está {status}. Dejamos de buscar actualizaciones.',
    'claimant.status.stale': 'No pudimos actualizar el estado. Reintentando automáticamente.',
    'claimant.status.reported': 'Reportado',
    'claimant.status.validating': 'Verificando datos',
    'claimant.status.triaged': 'Revisado',
    'claimant.status.assigned': 'Ajustador asignado',
    'claimant.status.fast_tracked': 'Vía rápida',
    'claimant.status.in_review': 'En revisión',
    'claimant.status.pending_info': 'Necesitamos más información',
    'claimant.status.closed': 'Cerrado',
    'claimant.status.withdrawn': 'Retirado',
    'claimant.status.current': 'Paso actual',
    'claimant.status.complete': 'Completado',
    'claimant.status.upcoming': 'Próximo'
  }
};

/**
 * Register every claimant table with the shared i18n registry.
 * @param {(locale: string, table: Record<string,string>) => void} registerStrings
 */
export function registerClaimantStrings(registerStrings) {
  for (const [locale, table] of Object.entries(claimantStrings)) registerStrings(locale, table);
}

/**
 * Minimal translator for tests and fallbacks (no kit needed).
 * @param {string} [locale]
 * @returns {(key: string, params?: Record<string, unknown>) => string}
 */
export function makeTranslator(locale = 'en') {
  return (key, params = {}) => {
    const raw = claimantStrings[locale]?.[key] ?? claimantStrings.en[key] ?? key;
    return raw.replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined ? `{${k}}` : String(params[k])));
  };
}

/**
 * Pick text from an I18nText (string or locale map).
 * @param {string | Record<string,string> | undefined | null} value
 * @param {string} [locale]
 * @returns {string}
 */
export function localText(value, locale = 'en') {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const base = String(locale).split('-')[0];
  return value[locale] ?? value[base] ?? value.en ?? Object.values(value)[0] ?? '';
}
