// The homepage, shown only for the bare domain. Real short links never reach
// it (the proxy redirects them first), and unknown paths render
// app/not-found.tsx instead.
export default function Home() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        // Times New Roman is a deliberate touch for the public landing page;
        // the rest of the site (admin) keeps the default UI sans-serif.
        fontFamily: '"Times New Roman", Times, serif',
      }}
    >
      <p style={{ color: "var(--muted)", textAlign: "center", maxWidth: "28rem" }}>
        There is nothing here.
      </p>
    </main>
  );
}
