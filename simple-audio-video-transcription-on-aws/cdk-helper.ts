import { readFileSync } from "fs";
import { load } from "js-yaml";

export interface CDKHelperConfig {}

export function loadConfig(filename: string, defaults: any = {}): CDKHelperConfig {

  let config: CDKHelperConfig = {}

  // default values for the stacks
  const defaultConfig = load(readFileSync('values.default.yaml', 'utf8')) as CDKHelperConfig
  config = {...config, ...defaultConfig}

  // custom config values for the stacks
  const customConfig = load(readFileSync(filename, 'utf8')) as CDKHelperConfig;
  config = {...config, ...customConfig}

  return config

}
