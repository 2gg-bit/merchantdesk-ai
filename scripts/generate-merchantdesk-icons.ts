/** Render our original SVG to platform icon containers. No upstream product artwork is used. */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const resources = join(root, 'apps/electron/resources');
const svg = readFileSync(join(resources, 'merchantdesk.svg'));
const png = async (size: number) => sharp(svg).resize(size, size).png().toBuffer();
const png1024 = await png(1024);
const png256 = await png(256);
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png256.length, 14); icoHeader.writeUInt32LE(22, 18);
const ico = Buffer.concat([icoHeader, png256]);
const chunkHeader = Buffer.alloc(8); chunkHeader.write('ic10'); chunkHeader.writeUInt32BE(png1024.length + 8, 4);
const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns'); icnsHeader.writeUInt32BE(png1024.length + 16, 4);
writeFileSync(join(resources, 'icon.png'), png1024);
writeFileSync(join(resources, 'icon.ico'), ico);
writeFileSync(join(resources, 'icon.icns'), Buffer.concat([icnsHeader, chunkHeader, png1024]));
for (const path of ['icon.svg', 'icon.icon/Assets/icon.svg']) writeFileSync(join(resources, path), svg);
writeFileSync(join(root, 'apps/electron/src/renderer/assets/craft_logo_c.svg'), svg);
writeFileSync(join(root, 'apps/webui/src/public/favicon.svg'), svg);
writeFileSync(join(root, 'apps/webui/src/public/favicon.ico'), ico);
writeFileSync(join(root, 'apps/webui/src/public/apple-touch-icon.png'), await png(180));
console.log('MerchantDesk platform icons generated.');

const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380"><rect width="540" height="380" fill="#edf5f2"/><text x="270" y="70" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#12363d">MerchantDesk</text><path d="M225 200h90m-18-15 18 15-18 15" fill="none" stroke="#12363d" stroke-width="4"/><text x="270" y="320" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#12363d">Drag MerchantDesk to Applications</text></svg>`);
writeFileSync(join(resources, 'merchantdesk-dmg.png'), await sharp(background).png().toBuffer());
