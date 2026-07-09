import { ISystem, System } from "../models/System";

let systems: ISystem[] = [];

export async function initSystemCache(): Promise<void> {
  systems = await System.find();
}

export function getCachedSystems(): ISystem[] {
  return systems;
}
