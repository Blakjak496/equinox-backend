import { IType, Type } from "../models/Type";
import { fetchJson } from "./general-utils";

export async function ensureTypeIsCached(
  typeId: number,
): Promise<IType | null> {
  const type = await Type.findOne({ typeId });
  if (type) return type;

  const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility`;
  const typeResponse = await fetchJson<{
    name: string;
  }>(url, "EquinoxGalactic Admin (types cache)");

  if (!typeResponse.ok || !typeResponse.json) {
    throw new Error(
      `ESI system failed ${typeResponse.status}: ${typeResponse.text}`,
    );
  }

  const newType = await Type.findOneAndUpdate(
    { typeId },
    { typeId, name: typeResponse.json.name },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return newType;
}
