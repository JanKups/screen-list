export default function DashboardPage() {
  return (
    <main style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>
      <h1>Dashboard</h1>
      <p>
        Protected reviewer content. This page only renders when the{" "}
        <code>sr_fixture_auth</code> cookie is present — the middleware redirects
        unauthenticated requests to <code>/login</code>.
      </p>
    </main>
  );
}
