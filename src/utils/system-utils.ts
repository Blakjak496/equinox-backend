import { ISystem, System } from "../models/System";
import { fetchJson } from "./general-utils";

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

export async function resolveSystemNameToId(
  name: string,
): Promise<number | null> {
  const res = await fetch(
    "https://esi.evetech.net/latest/universe/ids/?datasource=tranquility",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "EquinoxGalactic Admin (system name resolve)",
      },
      body: JSON.stringify([name]),
    },
  );

  if (!res.ok) {
    throw new Error(`ESI name resolve failed ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    systems?: { id: number; name: string }[];
  };

  const match = json.systems?.find(
    (system) => system.name.toLowerCase() === name.toLowerCase(),
  );

  return match?.id ?? null;
}
