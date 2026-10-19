// Code tables. Platform codes are mapped per profile; a tenant can override causes through
// TenantConfig.integrations.claimsPort.settings.causeCodes.

export const CAUSES = Object.freeze([
  'collision', 'collision_animal', 'single_vehicle', 'hit_and_run', 'glass', 'theft', 'vandalism', 'fire',
  'lightning', 'wind', 'hail', 'water_weather', 'water_plumbing', 'flood', 'freeze', 'falling_object',
  'liability_bodily_injury', 'liability_property_damage', 'other',
]);

export const CAUSE_CODES = Object.freeze({
  A: {
    collision: 'COLL', collision_animal: 'ANIMALCOLL', single_vehicle: 'SINGLEVEH', hit_and_run: 'HITRUN', glass: 'GLASS',
    theft: 'THEFT', vandalism: 'VANDAL', fire: 'FIRE', lightning: 'LIGHTNING', wind: 'WIND', hail: 'HAIL',
    water_weather: 'WATERWX', water_plumbing: 'WATERPLMB', flood: 'FLOOD', freeze: 'FREEZE', falling_object: 'FALLOBJ',
    liability_bodily_injury: 'LIABBI', liability_property_damage: 'LIABPD', other: 'OTHER',
  },
  B: Object.fromEntries(CAUSES.map((c, i) => [c, String(i + 1).padStart(2, '0')])),
});

export const ROLE_CODES = Object.freeze({
  A: {
    insured: 'Insured', claimant: 'Claimant', driver: 'Driver', witness: 'Witness', third_party: 'ThirdParty',
    passenger: 'Passenger', owner: 'Owner', reporter: 'Reporter', attorney: 'Attorney', medical_provider: 'MedicalProvider',
  },
  B: {
    insured: 'INS', claimant: 'CLM', driver: 'DRV', witness: 'WIT', third_party: 'TPT',
    passenger: 'PAS', owner: 'OWN', reporter: 'REP', attorney: 'ATY', medical_provider: 'MED',
  },
});

/** Used only when TenantConfig.lobs has no acordLobCd for the claim's line of business. */
export const DEFAULT_LOB_CODES = Object.freeze({ personal_auto: 'AUTOP', homeowners: 'HOME', commercial_auto: 'AUTOB' });

/**
 * Resolve a cause code for a profile, honouring tenant overrides.
 * @returns {{ code: string, warning?: string }}
 */
export function causeCode(profile, cause, overrides = {}) {
  const code = overrides?.[cause] ?? CAUSE_CODES[profile][cause];
  if (code) return { code };
  return { code: CAUSE_CODES[profile].other, warning: `loss cause "${cause}" has no code in profile ${profile}; sent as OTHER` };
}

/** @returns {{ code: string|undefined, warning?: string }} */
export function lobCode(lob, config) {
  const fromTenant = config?.lobs?.find?.((l) => l.id === lob)?.acordLobCd;
  if (fromTenant) return { code: fromTenant };
  if (DEFAULT_LOB_CODES[lob]) return { code: DEFAULT_LOB_CODES[lob], warning: `no acordLobCd configured for lob "${lob}"; used built-in default` };
  return { code: undefined, warning: `no ACORD LOB code for lob "${lob}"` };
}
