import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const source = fileURLToPath(new URL('../../../source/', import.meta.url))
const require = createRequire(path.join(source, 'package.json'))
const asar = require('@electron/asar')
const yaml = require('js-yaml')
const release = path.join(source, 'release')
const resources = process.argv[2] ? path.resolve(process.argv[2]) : path.join(release, 'win-unpacked/resources')
const hash = (file, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(fs.readFileSync(file)).digest(encoding)
const metadata = yaml.load(fs.readFileSync(path.join(release, 'latest.yml'), 'utf8'))
assert.equal(metadata.version, '1.2.24')
const installer = path.join(release, 'AI-Chatbot-Setup-1.2.24.exe')
assert.equal(metadata.files[0].url, path.basename(installer))
if (metadata.files[0].size !== undefined) assert.equal(metadata.files[0].size, fs.statSync(installer).size)
assert.equal(metadata.files[0].sha512, hash(installer, 'sha512', 'base64'))
assert.equal(metadata.sha512, hash(installer, 'sha512', 'base64'))
const archive = path.join(resources, 'app.asar')
assert.equal(JSON.parse(asar.extractFile(archive, 'package.json')).version, '1.2.24')
assert.deepEqual(asar.extractFile(archive, 'desktop/page-enhancements.js'), fs.readFileSync(path.join(source, 'desktop/page-enhancements.js')))
const dist = path.join(source, '../origin resource/frontend/dist')
const assets = fs.readdirSync(path.join(dist, 'assets')).sort()
assert.deepEqual(fs.readdirSync(path.join(resources, 'frontend/assets')).sort(), assets)
for (const relative of ['index.html', ...assets.map((name) => 'assets/' + name)]) {
  assert.equal(hash(path.join(resources, 'frontend', relative)), hash(path.join(dist, relative)))
}
assert.equal(hash(path.join(resources, 'backend/chatbot-backend.exe')), hash(path.join(source, '../origin resource/backend/dist/chatbot-backend.exe')))
const result = { version: metadata.version, installer: path.basename(installer), resources,
  size: fs.statSync(installer).size, sha256: hash(installer),
  assets, asar: 'matches source', backend: 'matches smoke-tested executable', latestYml: 'version, URL and SHA-512 verified' }
fs.writeFileSync(path.join(release, 'qa-1.2.24/package-verification.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
