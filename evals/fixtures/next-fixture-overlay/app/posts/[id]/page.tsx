export default async function PostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>
      <h1>Post: {id}</h1>
      <p>
        This page renders visibly different content for each id. You are viewing
        post <strong>{id}</strong>.
      </p>
    </main>
  );
}
