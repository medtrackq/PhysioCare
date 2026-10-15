/**
 * Storage driver (local disk). สลับเป็น S3/MinIO ได้โดย implement put/stream/remove ชุดเดียวกัน
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

const resolveKey = (key) => {
  const full = path.resolve(config.uploadDir, key);
  if (!full.startsWith(config.uploadDir + path.sep)) throw new Error('invalid storage key');
  return full;
};

module.exports = {
  async put(key, buffer) {
    const full = resolveKey(key);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buffer, { flag: 'wx' });
  },
  stream(key) {
    return fs.createReadStream(resolveKey(key));
  },
  async remove(key) {
    await fsp.rm(resolveKey(key), { force: true });
  },
};
