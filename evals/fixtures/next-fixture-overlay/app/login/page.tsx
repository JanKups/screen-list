import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// Fixture credentials (invented test data — see setup-next-fixture.sh header).
const FIXTURE_EMAIL = "reviewer@example.com";
const FIXTURE_PASSWORD = "fixture-pass-1";

async function login(formData: FormData) {
  "use server";
  const email = formData.get("email");
  const password = formData.get("password");
  if (email === FIXTURE_EMAIL && password === FIXTURE_PASSWORD) {
    (await cookies()).set("sr_fixture_auth", "1", {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    });
    redirect("/dashboard");
  }
  redirect("/login?error=1");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>
      <h1>Log in</h1>
      {error ? (
        <p style={{ color: "crimson" }}>Invalid credentials. Try again.</p>
      ) : null}
      <form action={login} style={{ display: "grid", gap: 12, maxWidth: 280 }}>
        <input name="email" type="email" placeholder="Email" autoComplete="username" />
        <input
          name="password"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
        />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
