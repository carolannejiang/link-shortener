// The homepage. Real short links never reach this — the middleware redirects
// them first. This only shows for the bare domain or an unknown slug.
export default function Home() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
      }}
    >
      <p style={{ color: "var(--muted)" }}>
        Nothing here. <a href="/admin">Admin</a>
      </p>
    </main>
  );
}
