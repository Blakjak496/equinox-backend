import { Config, IConfig } from "../models/Config";

let config: IConfig | null;

export async function initConfig() {
  config = await Config.findOne();
}

export function getConfig(): IConfig {
  if (!config) throw new Error("Config document is missing");
  return config;
}
