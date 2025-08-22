import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const isDev = process.env.NODE_ENV !== 'production';

  // CSP: loosened for dev, stricter for prod
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://*.supabase.co",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'" + (isDev ? " 'unsafe-eval'" : "")
  ].join('; ');

  res.headers.set('Content-Security-Policy', csp);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('X-Frame-Options', 'DENY');

  return res;
}

export const config = { matcher: '/:path*' };