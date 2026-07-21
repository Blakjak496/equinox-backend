import { IRegion, Region } from "../models/Region";
import { fetchJson } from "./general-utils";

export async function ensureRegionIsCached(
  regionId: number,
): Promise<IRegion | null> {
  const region = await Region.findOne({ regionId });
  if (region) return region;

  const url = `https://esi.evetech.net/latest/universe/regions/${regionId}/?datasource=tranquility`;
  const regionResponse = await fetchJson<{
    name: string;
  }>(url, "EquinoxGalactic Admin (regions cache)");

  if (!regionResponse.ok || !regionResponse.json) {
    throw new Error(
      `ESI region failed ${regionResponse.status}: ${regionResponse.text}`,
    );
  }

  const newRegion = await Region.findOneAndUpdate(
    { regionId },
    { regionId, name: regionResponse.json.name },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return newRegion;
}
