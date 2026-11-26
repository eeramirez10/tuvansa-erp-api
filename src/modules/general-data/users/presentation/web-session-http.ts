import type { CorsOptions } from 'cors';
import type { CookieOptions, Request, RequestHandler } from 'express';
import { env } from '../../../../config/env.js';
import { ApplicationError } from '../../../../shared/domain/errors/application-error.js';
import { tokenPattern } from '../infrastructure/web-credentials.js';

const crossOriginPath = env.WEB_SESSION_CROSS_ORIGIN_PATH;
const secure = env.NODE_ENV === 'production' || Boolean(crossOriginPath);
export const cookieName = crossOriginPath ? '__Secure-tuvansa_session_beta'
  : secure ? '__Host-tuvansa_session' : 'tuvansa_session';
export const sessionCookie: CookieOptions = crossOriginPath
  ? { httpOnly: true, secure: true, sameSite: 'none', partitioned: true, path: crossOriginPath }
  : { httpOnly: true, secure, sameSite: 'strict', path: '/' };

export const webSessionCors: CorsOptions = crossOriginPath ? {
  origin: (origin, allow) => allow(null, origin === env.WEB_SESSION_ORIGIN),
  credentials: true,
} : { origin: env.CORS_ORIGINS };

export const sessionToken = (request: Request): string | undefined => {
  const raw = request.headers.cookie?.split(';').map(cookie => cookie.trim()).find(cookie => cookie.startsWith(`${cookieName}=`));
  const token = raw?.slice(cookieName.length + 1);
  return token && tokenPattern.test(token) ? token : undefined;
};

export const noSessionCache: RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
};

export const requireSessionOrigin = (request: Request) => {
  const host = request.get('host') ?? '';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host) && !secure ? `${request.protocol}://${host}` : '';
  const expected = env.WEB_SESSION_ORIGIN || local;
  if (!expected || (secure && !expected.startsWith('https://'))) {
    throw new ApplicationError('El origen HTTPS de la sesión web no está configurado.', 'WEB_ORIGIN_NOT_CONFIGURED', 503);
  }
  if (request.get('origin') !== expected) {
    throw new ApplicationError('La solicitud debe provenir de la web de Tuvansa.', 'WEB_ORIGIN_FORBIDDEN', 403);
  }
};
