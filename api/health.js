// GET /api/health — confirms the /api folder is wired up on Vercel.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    time: new Date().toISOString() // UTC, as all server times will be
  });
}
