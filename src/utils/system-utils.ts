import { ISystem, System } from "../models/System";
import { fetchJson, postJson } from "./general-utils";

export async function ensureSystemIsCached(
  systemId: number,
): Promise<ISystem | null> {
  const system = await System.findOne({ systemId });
  if (system && system.position && system.securityStatus !== null) {
    return system;
  }

  const url = `https://esi.evetech.net/latest/universe/systems/${systemId}/?datasource=tranquility`;
  const systemResponse = await fetchJson<{
    name: string;
    position: { x: number; y: number; z: number };
    security_status: number;
  }>(url, "EquinoxGalactic Admin (systems cache)");

  if (!systemResponse.ok || !systemResponse.json) {
    throw new Error(
      `ESI system failed ${systemResponse.status}: ${systemResponse.text}`,
    );
  }

  const solarSystem = await System.findOneAndUpdate(
    { systemId },
    {
      systemId,
      name: String(systemResponse.json.name),
      position: systemResponse.json.position,
      securityStatus: systemResponse.json.security_status,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return solarSystem;
}

export async function getSystemIdByName(name: string): Promise<number | null> {
  const url = "https://esi.evetech.net/latest/universe/ids/?datasource=tranquility";
  const idsResponse = await postJson<{
    systems?: { id: number; name: string }[];
  }>(url, "EquinoxGalactic Admin (system name lookup)", [name]);

  if (!idsResponse.ok || !idsResponse.json) {
    throw new Error(
      `ESI name lookup failed ${idsResponse.status}: ${idsResponse.text}`,
    );
  }

  const match = idsResponse.json.systems?.find(
    (system) => system.name.toLowerCase() === name.toLowerCase(),
  );

  return match?.id ?? null;
}
