import { IStation, Station } from "../models/Station";
import { IStructure, Structure } from "../models/Structure";
import { ISystem } from "../models/System";
import { IType } from "../models/Type";
import { checkEsiLimitFromHeader, fetchJsonWithBearer } from "./general-utils";
import { ensureSystemIsCached } from "./system-utils";
import { ensureTypeIsCached } from "./type-utils";

const stationIdCap = 4_294_967_295;

export const getOrFetchStructure = async (
  locationId: number,
  accessToken: string,
): Promise<IStructure | IStation | null> => {
  if (locationId <= stationIdCap) {
    const station = await Station.findOne({ stationId: Number(locationId) });
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

      return station;
    }
  } else {
    const structure = await Structure.findOne({ structureId: locationId });
    if (structure) return structure;
    else {
      const url = `https://esi.evetech.net/latest/universe/structures/${locationId}/?datasource=tranquility`;
      const structureResponse = await fetchJsonWithBearer<{
        name: string;
        owner_id: number;
        system_id: number;
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

      const systemId = structureResponse.json.system_id;
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

      return structure;
    }
  }
};
