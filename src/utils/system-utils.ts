import { ISystem, System } from "../models/System";
import { fetchJson } from "./general-utils";

export async function ensureSystemIsCached(
  systemId: number,
): Promise<ISystem | null> {
  const system = await System.findOne({ systemId });
  if (system) return system;

  const url = `https://esi.evetech.net/latest/universe/systems/${systemId}/?datasource=tranquility`;
  const systemResponse = await fetchJson<{
    name: string;
  }>(url, "EquinoxGalactic Admin (systems cache)");

  if (!systemResponse.ok || !systemResponse.json) {
    throw new Error(
      `ESI system failed ${systemResponse.status}: ${systemResponse.text}`,
    );
  }

  const solarSystem = await System.findOneAndUpdate(
    { systemId },
    { systemId, name: String(systemResponse.json.name) },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return solarSystem;
}
