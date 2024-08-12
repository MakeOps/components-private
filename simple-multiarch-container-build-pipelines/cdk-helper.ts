import { readFileSync } from "fs";
import { load } from "js-yaml";

export interface CDKHelperConfig {}

export function loadConfig(): CDKHelperConfig {

  let config: CDKHelperConfig = {}

  // default values for the stacks
  const defaultConfig = load(readFileSync('values.default.yaml', 'utf8')) as CDKHelperConfig
  config = {...config, ...defaultConfig}

  // custom config values for the stacks
  try {
    const customConfig = load(readFileSync('values.yaml', 'utf8')) as CDKHelperConfig;
    config = {...config, ...customConfig}
  } catch (err) {
    console.log('No values.yaml provided, using values.default.yaml')
  }

  return config

}
