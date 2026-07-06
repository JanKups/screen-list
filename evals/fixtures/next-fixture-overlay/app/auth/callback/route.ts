import { NextResponse } from "next/server";

// Exclusion bait: an auth-callback-style route that immediately redirects.
// Route discovery must exclude this (*callback* heuristic + non-rendering
// immediate redirect), never screenshot it.
export function GET(request: Request) {
  return NextResponse.redirect(new URL("/", request.url));
}
