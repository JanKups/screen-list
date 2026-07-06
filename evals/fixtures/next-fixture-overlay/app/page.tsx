import Link from "next/link";

export default function Home() {
  return (
    <main style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>
      <h1>next-fixture</h1>
      <p>Reproducible Next.js App Router fixture for screenshot-review-web evals.</p>
      <ul>
        <li>
          <Link href="/posts/hello-world">/posts/hello-world</Link> (dynamic route)
        </li>
        <li>
          <Link href="/about">/about</Link> (route group: (marketing))
        </li>
        <li>
          <Link href="/login">/login</Link> (fake login)
        </li>
        <li>
          <Link href="/dashboard">/dashboard</Link> (cookie-gated)
        </li>
      </ul>
    </main>
  );
}
