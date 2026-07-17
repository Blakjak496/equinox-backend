import { IStation, Station } from "../models/Station";
import { IStructure, Structure } from "../models/Structure";
import { ISystem } from "../models/System";
import { IType } from "../models/Type";
import { checkEsiLimitFromHeader, fetchJsonWithBearer } from "./general-utils";
import { ensureSystemIsCached } from "./system-utils";
import { ensureTypeIsCached } from "./type-utils";

const stationIdCap = 4_294_967_295;

// When a brand-new structure/station ID resolves successfully, check for
// other cached entries under the exact same name - the common case is a
// player structure that was destroyed and rebuilt under the same name with
// a new ID. If the old entry is a Structure already confirmed dead (access:
// "forbidden" - ESI denied it on a previous lookup), it's safe to drop in
// favor of the new, live one so there's a single current entry under that
// name. If the old entry still looks live, both are kept, but the new one
// is suffixed so search results don't show two indistinguishable rows.
async function reconcileDuplicateName(
  kind: "structure" | "station",
  newId: number,
  name: string | null,
): Promise<void> {
  if (!name) return;

  if (kind === "structure") {
    const stale = await Structure.find({ name, structureId: { $ne: newId } });
    for (const doc of stale) {
      if (doc.access === "forbidden") {
        await Structure.deleteOne({ _id: doc._id });
      } else {
        await Structure.updateOne(
          { structureId: newId },
          { name: `${name} (2)` },
        );
      }
    }
  } else {
    const stale = await Station.find({ name, stationId: { $ne: newId } });
    if (stale.length > 0) {
      await Station.updateOne({ stationId: newId }, { name: `${name} (2)` });
    }
  }
}

export const getOrFetchStructure = async (
  locationId: number,
  accessToken: string,
  options: { forceRefresh?: boolean } = {},
): Promise<IStructure | IStation | null> => {
  if (locationId <= stationIdCap) {
    const station = options.forceRefresh
      ? null
      : await Station.findOne({ stationId: Number(locationId) });
    if (station) return station;
    else {
      const url = `https://esi.evetech.net/latest/universe/stations/${locationId}/?datasource=tranquility`;
      const stationResponse = await fetchJsonWithBearer<{
        name?: string;
        owner?: number;
        system_id: number;
        type_id: number;
        position?: { x: number; y: number; z: number };
      }>(url, accessToken, "EquinoxGalactic Admin (stations cache)");

      checkEsiLimitFromHeader(stationResponse.headers);

      if (!stationResponse.ok || !stationResponse.json) {
        throw new Error(
          `ESI structure failed ${stationResponse.status}: ${stationResponse.text}`,
        );
      }

      const systemId = stationResponse.json.system_id;
      const typeId = stationResponse.json.type_id;

      const system: ISystem | null = await ensureSystemIsCached(systemId);
      const type: IType | null = await ensureTypeIsCached(typeId);

      const station: IStation | null = await Station.findOneAndUpdate(
        { stationId: Number(locationId) },
        {
          stationId: Number(locationId),
          name: stationResponse.json.name,
          ownerId: Number(stationResponse.json.owner),
          systemId: Number(system!.systemId),
          systemName: String(system!.name),
          typeId: Number(typeId),
          typeName: String(type!.name),
          position: stationResponse.json.position,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      await reconcileDuplicateName(
        "station",
        Number(locationId),
        stationResponse.json.name ?? null,
      );

      return station;
    }
  } else {
    const structure = options.forceRefresh
      ? null
      : await Structure.findOne({ structureId: locationId });
    if (structure) return structure;
    else {
      const url = `https://esi.evetech.net/latest/universe/structures/${locationId}/?datasource=tranquility`;
      const structureResponse = await fetchJsonWithBearer<{
        name: string;
        owner_id: number;
        solar_system_id: number;
        type_id: number;
        position: { x: number; y: number; z: number };
      }>(url, accessToken, "EquinoxGalactic Admin (structures cache)");

      checkEsiLimitFromHeader(structureResponse.headers);

      if (structureResponse.status === 403) {
        const structure = await Structure.findOneAndUpdate(
          { structureId: Number(locationId) },
          {
            structureId: Number(locationId),
            access: "forbidden",
            name: null,
            ownerId: null,
            systemId: null,
            systemName: null,
            typeId: null,
            typeName: null,
            position: null,
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
          },
        );

        return structure;
      }

      if (!structureResponse.ok || !structureResponse.json) {
        throw new Error(
          `ESI structure failed ${structureResponse.status}: ${structureResponse.text}`,
        );
      }

      const systemId = structureResponse.json.solar_system_id;
      const typeId = structureResponse.json.type_id;

      const system: ISystem | null = await ensureSystemIsCached(systemId);
      const type: IType | null = await ensureTypeIsCached(typeId);

      const structure: IStructure | null = await Structure.findOneAndUpdate(
        { structureId: Number(locationId) },
        {
          structureId: Number(locationId),
          access: "ok",
          name: structureResponse.json.name,
          ownerId: Number(structureResponse.json.owner_id),
          systemId: Number(system!.systemId),
          systemName: String(system!.name),
          typeId: Number(typeId),
          typeName: String(type!.name),
          position: structureResponse.json.position,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      await reconcileDuplicateName(
        "structure",
        Number(locationId),
        structureResponse.json.name,
      );

      return structure;
    }
  }
};
