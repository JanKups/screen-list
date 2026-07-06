export default function AboutPage() {
  return (
    <main style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>
      <h1>About</h1>
      <p>
        This page lives in the <code>(marketing)</code> route group. The group
        segment does not appear in the URL — this page is served at{" "}
        <code>/about</code>.
      </p>
    </main>
  );
}
