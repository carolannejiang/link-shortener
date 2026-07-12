// Rendered for any path that isn't a page or a live short link — the proxy
// redirects real slugs before this ever runs, so what lands here is typos,
// deleted links, and disabled links. Exactly the moment a human needs a
// pointer instead of a bare 404.
export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
        // Match the homepage's deliberate Times New Roman touch.
        fontFamily: '"Times New Roman", Times, serif',
      }}
    >
      <p style={{ color: "var(--muted)", textAlign: "center", maxWidth: "28rem" }}>
        There is no link here. If one brought you to this page, it may have
        moved or been switched off — contact{" "}
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
