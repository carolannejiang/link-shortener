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
        // Times New Roman is a deliberate touch for the public landing page;
        // the rest of the site (admin) keeps the default UI sans-serif.
        fontFamily: '"Times New Roman", Times, serif',
      }}
    >
      <p style={{ color: "var(--muted)", textAlign: "center", maxWidth: "28rem" }}>
        There is nothing here. If you were looking for a link, contact{" "}
        <a
          href="https://carolannejiang.com"
          style={{ color: "var(--link)", textDecoration: "none" }}
        >
          Carolanne
        </a>
        .
      </p>
    </main>
  );
}
