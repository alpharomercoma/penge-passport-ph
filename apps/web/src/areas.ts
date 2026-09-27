// Which part of the country each office is in, so people can look near them.
// Keyed by the office's place name as the DFA writes it; an office the DFA adds
// later shows under "Other" until it is added here.
export const AREAS = ['NCR', 'Luzon', 'Visayas', 'Mindanao'] as const;
export type Area = (typeof AREAS)[number] | 'Other';

const BY_PLACE: Record<string, Area> = {
  'dfa manila': 'NCR',
  'dfa ncr central': 'NCR',
  'dfa ncr east': 'NCR',
  'dfa ncr north': 'NCR',
  'dfa ncr northeast': 'NCR',
  'dfa ncr south': 'NCR',
  'dfa ncr west': 'NCR',
  angeles: 'Luzon',
  antipolo: 'Luzon',
  baguio: 'Luzon',
  balanga: 'Luzon',
  calasiao: 'Luzon',
  candon: 'Luzon',
  dasmariñas: 'Luzon',
  'ilocos norte': 'Luzon',
  'la union': 'Luzon',
  legazpi: 'Luzon',
  lipa: 'Luzon',
  lucena: 'Luzon',
  malolos: 'Luzon',
  olongapo: 'Luzon',
  pampanga: 'Luzon',
  'paniqui, tarlac': 'Luzon',
  'puerto princesa': 'Luzon',
  'san pablo': 'Luzon',
  'santiago, isabela': 'Luzon',
  tuguegarao: 'Luzon',
  antique: 'Visayas',
  bacolod: 'Visayas',
  cebu: 'Visayas',
  dumaguete: 'Visayas',
  iloilo: 'Visayas',
  tacloban: 'Visayas',
  tagbilaran: 'Visayas',
  butuan: 'Mindanao',
  'cagayan de oro': 'Mindanao',
  clarin: 'Mindanao',
  davao: 'Mindanao',
  'general santos': 'Mindanao',
  kidapawan: 'Mindanao',
  pagadian: 'Mindanao',
  tagum: 'Mindanao',
  zamboanga: 'Mindanao',
};

export function areaOf(place: string): Area {
  return BY_PLACE[place.toLowerCase()] ?? 'Other';
}
