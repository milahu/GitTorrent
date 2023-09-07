import fs from 'fs'
import rc from 'rc'

import { createRequire } from 'module'

const require = createRequire(import.meta.url)

export async function getConfig() {
  // make 'rc' available in user config
  globalThis.rc = rc

  const configDir = process.env.HOME + '/.config/gittorrent'
  let configPath = ''

  // CJS config
  configPath = configDir + '/config.js'
  if (fs.existsSync(configPath)) {
    const config = require(configPath)
    console.log('loading config: ' + configPath)
    return [config, configDir]
  }

  // ESM config
  configPath = configDir + '/config.mjs'
  if (!fs.existsSync(configPath)) {
    console.log('creating default config file: ' + configPath)
    const configText = fs.readFileSync(require.resolve('./default-config.mjs'), 'utf8')
    fs.writeFileSync(configPath, configText, 'utf8')
    // fix: file has mode 0o050
    fs.chmodSync(configPath, 0o644)
  }
  const config = (await import(configPath)).default
  console.log('loading config: ' + configPath)
  return [config, configDir]
}
