import { NextRequest, NextResponse } from "next/server";

// Edge auth gate: pages require the session cookie; API routes are proxied
// and enforce auth server-side themselves.
const PUBLIC_PATHS = ["/login", "/health"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/socket.io") ||
    pathname.startsWith("/_next") ||
    pathname.includes(".")
  ) {
    return NextResponse.next();
  }
  const session = req.cookies.get("session");
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
