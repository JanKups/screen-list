import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Cookie-gate /dashboard: unauthenticated requests are redirected to /login.
// The login form sets `sr_fixture_auth=1` on success.
export function middleware(request: NextRequest) {
  const authed = request.cookies.get("sr_fixture_auth")?.value === "1";
  if (!authed) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
