import type { SeedDoc } from "./types.js";

export type City = { id: string; name: string; region: string };
export type PickupPoint = {
  id: string;
  cityId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
};

// Hand-written rather than generated: they are few, and real places read better in a demo.
export const CITIES: readonly City[] = [
  { id: "ct_milano", name: "Milano", region: "Lombardia" },
  { id: "ct_roma", name: "Roma", region: "Lazio" },
  { id: "ct_torino", name: "Torino", region: "Piemonte" },
];

export const PICKUP_POINTS: readonly PickupPoint[] = [
  pickup(
    "pp_milano_centrale",
    "ct_milano",
    "Stazione Centrale",
    "Piazza Duca d'Aosta 1",
    45.4859,
    9.2035,
  ),
  pickup("pp_milano_duomo", "ct_milano", "Duomo", "Piazza del Duomo 1", 45.4642, 9.19),
  pickup(
    "pp_milano_garibaldi",
    "ct_milano",
    "Porta Garibaldi",
    "Piazza Sigmund Freud 1",
    45.4846,
    9.188,
  ),
  pickup("pp_milano_navigli", "ct_milano", "Navigli", "Ripa di Porta Ticinese 1", 45.452, 9.176),
  pickup("pp_roma_termini", "ct_roma", "Termini", "Piazza dei Cinquecento 1", 41.901, 12.5011),
  pickup("pp_roma_colosseo", "ct_roma", "Colosseo", "Piazza del Colosseo 1", 41.8902, 12.4922),
  pickup("pp_roma_trastevere", "ct_roma", "Trastevere", "Piazza Mastai 1", 41.881, 12.47),
  pickup("pp_roma_eur", "ct_roma", "EUR Fermi", "Viale America 1", 41.83, 12.47),
  pickup(
    "pp_torino_porta_nuova",
    "ct_torino",
    "Porta Nuova",
    "Corso Vittorio Emanuele II 53",
    45.062,
    7.678,
  ),
  pickup(
    "pp_torino_porta_susa",
    "ct_torino",
    "Porta Susa",
    "Piazza XVIII Dicembre 1",
    45.072,
    7.665,
  ),
  pickup("pp_torino_lingotto", "ct_torino", "Lingotto", "Via Nizza 280", 45.03, 7.665),
  pickup("pp_torino_castello", "ct_torino", "Piazza Castello", "Piazza Castello 1", 45.071, 7.686),
];

export function cityById(cityId: string): City {
  const city = CITIES.find((candidate) => candidate.id === cityId);
  if (!city) throw new Error(`Unknown city ${cityId}`);
  return city;
}

export function pickupPointsIn(cityId: string): readonly PickupPoint[] {
  return PICKUP_POINTS.filter((point) => point.cityId === cityId);
}

export function cityDocs(): SeedDoc[] {
  return CITIES.map(({ id, name, region }) => ({ id, fields: { name, region } }));
}

export function pickupPointDocs(): SeedDoc[] {
  return PICKUP_POINTS.map(({ id, cityId, name, address, lat, lng }) => ({
    id,
    fields: { cityId, name, address, lat, lng },
  }));
}

function pickup(
  id: string,
  cityId: string,
  name: string,
  address: string,
  lat: number,
  lng: number,
): PickupPoint {
  return { id, cityId, name, address, lat, lng };
}
