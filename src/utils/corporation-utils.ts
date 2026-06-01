import { Alliance, EsiAlliance } from "../models/Alliance";
import {
  Corporation,
  EsiCorporation,
  ICorporation,
} from "../models/Corporation";
import { fetchJson } from "./general-utils";

export async function getOrFetchCorporation(
  corporationId: number,
  update: boolean = false,
): Promise<ICorporation> {
  let corp: ICorporation | null;
  corp = await Corporation.findOne({ corporationId });
  if (corp && !update) return corp as ICorporation;

  const url = `https://esi.evetech.net/corporations/${corporationId}`;
  const response = await fetchJson<EsiCorporation>(
    url,
    "EquinoxGalactic (Corporation Cache)",
  );
  if (!response || !response.json)
    throw new Error("No corporation found with the issuer_corporation_id");
  else {
    const json = response.json;
    corp = await Corporation.findOneAndUpdate(
      { corporationId },
      {
        corporationId,
        allianceId: json.alliance_id,
        name: json.name,
        ticker: json.ticker,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    const allianceExists = await Alliance.exists({
      allianceId: json.alliance_id,
    });
    if (!allianceExists && json.alliance_id) {
      const url = `https://esi.evetech.net/alliances/${json.alliance_id}`;
      const alliance = await fetchJson<EsiAlliance>(
        url,
        "EquinoxGalactic (Alliance Cache)",
      );
      if (!alliance || !alliance.json)
        throw new Error("No alliance found with the alliance ID");
      const allianceJson = alliance.json;
      await Alliance.create({
        allianceId: json.alliance_id,
        name: allianceJson.name,
        ticker: allianceJson.ticker,
      });
    }
  }

  return corp as ICorporation;
}
