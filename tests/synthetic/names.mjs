/** Fictional names, places and carriers. Phone numbers use the reserved 555-01xx range. */

export const FIRST_NAMES = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Quinn', 'Rowan', 'Harper', 'Emerson', 'Sloane', 'Devon', 'Marlowe', 'Linden', 'Perry', 'Ellis'];
export const LAST_NAMES = ['Ashgrove', 'Brindle', 'Calloway', 'Dunmore', 'Everhart', 'Fenwick', 'Galloway', 'Hollis', 'Ingram', 'Juniper', 'Kestrel', 'Lockhart', 'Marsden', 'Northcott', 'Oakridge', 'Pemberton'];
export const BUSINESS_NAMES = ['Brightfield Freight Co (fictional)', 'Cedar Hollow Logistics (fictional)', 'Lakeshore Mechanical Services (fictional)', 'Prairie Wind Delivery (fictional)'];
export const OTHER_CARRIERS = ['Evergreen Casualty Group (fictional)', 'Redwater Indemnity (fictional)', 'Summit Ridge Mutual (fictional)'];
export const AGENCIES = ['Riverbend Police Department (fictional)', 'Maple County Sheriff (fictional)', 'Oak Harbor Police Department (fictional)'];
export const REPAIR_SHOPS = ['Lakeview Collision Center (fictional)', 'Northside Auto Body (fictional)', 'Cardinal Glass and Trim (fictional)'];

export const STATES = {
  WI: { cities: [['Fairhaven', '53001'], ['Millbrook', '53002'], ['Stonebridge', '53003']], tz: 'America/Chicago' },
  IL: { cities: [['Elmwood Park', '60001'], ['Westfield', '60002'], ['Ridgemont', '60003']], tz: 'America/Chicago' },
  MI: { cities: [['Port Alder', '48001'], ['Cedar Falls', '48002'], ['Lakemont', '48003']], tz: 'America/Detroit' }
};
export const STREETS = ['Maple Ave', 'Birch Ln', 'Harbor St', 'Quarry Rd', 'Willow Ct', 'Sunset Blvd', 'Cobble Way', 'Elm St'];

/** @param {ReturnType<import('./prng.mjs').createRng>} rng */
export function person(rng) {
  return { firstName: rng.pick(FIRST_NAMES), lastName: rng.pick(LAST_NAMES) };
}

/** Fictional phone in the reserved 555-0100..0199 block. */
export function phone(rng) {
  return `(608) 555-01${String(rng.int(0, 99)).padStart(2, '0')}`;
}

/** Fictional address in the given state; falls back to WI. */
export function address(rng, state = 'WI') {
  const st = STATES[state] ? state : 'WI';
  const [city, postalCode] = rng.pick(STATES[st].cities);
  return { line1: `${rng.int(100, 9899)} ${rng.pick(STREETS)}`, city, state: st, postalCode, country: 'US' };
}

export function timeZoneFor(state) {
  return (STATES[state] || STATES.WI).tz;
}
