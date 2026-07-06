import { NextResponse } from "next/server";

// Exclusion bait: an API route handler under app/api/ — route discovery must
// exclude this (it returns JSON, it does not paint a page).
export function GET() {
  return NextResponse.json({ status: "ok", fixture: "next-fixture" });
}
