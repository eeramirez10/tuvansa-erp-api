import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { RowDataPacket } from 'mysql2';
import { env } from '../../../../../config/env.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';

export type ProductPhotoVariant = 'normal' | 'sketch' | 'second-sketch' | 'color' | 'full';

const missing = () => new NotFoundError('Foto del producto');

function missingFile(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readLegacyProductPhoto(code: string, variant: ProductPhotoVariant) {
  const [[settings]] = await legacyMysqlPool.execute<(RowDataPacket & { rootLength: number; colorLength: number; jpg: string })[]>(
    `SELECT CIARAIZ AS rootLength, CIATALLA AS colorLength, SUBSTRING(CIACOMPORTA,103,1) AS jpg
       FROM FCIA WHERE CIASEQ=1`,
  );
  if (String(settings?.jpg ?? '') !== '1') throw missing();

  const directory = env.LEGACY_PRODUCT_PHOTOS_DIR || (process.platform === 'win32' ? 'C:/PROSCAI/OMNIS/FOTOS' : '');
  const root = directory ? await realpath(directory).catch((error: unknown) => {
    if (missingFile(error)) return null;
    throw error;
  }) : null;
  if (!root) throw new ApplicationError('El directorio de fotos de German no está disponible.', 'PRODUCT_PHOTOS_UNAVAILABLE', 503);

  const rootLength = Number(settings?.rootLength);
  const prefixLength = rootLength > 0 ? rootLength + (variant === 'color' ? Number(settings?.colorLength ?? 0) : 0) : 13;
  const prefix = variant === 'full' ? code.trim() : code.trim().slice(0, prefixLength);
  const suffix = variant === 'sketch' ? 'Z' : variant === 'second-sketch' ? 'Y' : '';
  const stem = prefix + suffix;
  if (!prefix || /[\\/:*?"<>|]/.test(stem) || [...stem].some((character) => character.charCodeAt(0) < 32)) throw missing();

  for (const extension of ['.JPG', '.jpg']) {
    try {
      const photo = await realpath(join(root, stem + extension));
      const pathFromRoot = relative(root, photo);
      if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith('..' + sep) || isAbsolute(pathFromRoot)) throw missing();
      const image = await readFile(photo);
      if (image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) throw missing();
      return image;
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
  }
  throw missing();
}
