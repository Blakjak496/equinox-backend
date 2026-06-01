import { Character, EsiCharacter, ICharacter } from "../models/Character";
import { fetchJson } from "./general-utils";

export async function getOrFetchCharacter(
  characterId: number,
  update: boolean = false,
): Promise<ICharacter> {
  let character: ICharacter | null;
  character = await Character.findOne({ characterId });
  if (character && !update) return character as ICharacter;

  const url = `https://esi.evetech.net/characters/${characterId}`;
  const response = await fetchJson<EsiCharacter>(
    url,
    "EquinoxGalactic Admin (Character Cache)",
  );
  if (!response || !response.json)
    throw new Error("No character found with the issuer_id");
  else {
    const json: EsiCharacter = response.json;

    character = await Character.findOneAndUpdate(
      { characterId },
      {
        characterId,
        allianceId: json.alliance_id,
        corporationId: json.corporation_id,
        name: json.name,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return character as ICharacter;
  }
}
